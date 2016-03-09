module.exports = wizard;
// used for testing
module.exports.processAnswers = processAnswers;
module.exports.inquire = inquire;
module.exports.interactive = interactive;

var Promise = require('es6-promise').Promise; // jshint ignore:line

var debug = require('debug')('snyk');
var path = require('path');
var inquirer = require('inquirer');
var fs = require('then-fs');
var tryRequire = require('snyk-try-require');
var chalk = require('chalk');
var url = require('url');
var _ = require('lodash');
var undefsafe = require('undefsafe');
var auth = require('../auth');
var getVersion = require('../version');
var allPrompts = require('./prompts');
var snyk = require('../../../lib/');
var isCI = require('../../../lib/is-ci');
var protect = require('../../../lib/protect');
var config = require('../../../lib/config');
var spinner = require('../../../lib/spinner');
var analytics = require('../../../lib/analytics');
var npm = require('../../../lib/npm');
var cwd = process.cwd();

function wizard(options) {
  if (!options) {
    options = {};
  }

  spinner.sticky();

  if (options['dry-run']) {
    debug('*** dry run ****');
  } else {
    debug('~~~~ LIVE RUN ~~~~');
  }

  return snyk.policy.load(options).catch(function (error) {
    // if we land in the catch, but we're in interactive mode, then it means
    // the file hasn't been created yet, and that's fine, so we'll resolve
    // with an empty object
    if (error.code === 'ENOENT') {
      options.newPolicy = true;
      return {};
    }

    throw error;
  }).then(function (policy) {
    return auth.isAuthed().then(function (authed) {
      analytics.add('inline-auth', !authed);
      if (!authed) {
        return auth();
      }
    }).then(function () {
      var intro = __dirname + '/../../../help/wizard-intro.txt';
      return fs.readFile(intro, 'utf8').then(function (str) {
        if (!isCI) {
          console.log(str);
        }
      }).then(function () {
        return new Promise(function (resolve) {
          if (options.newPolicy) {
            return resolve(); // don't prompt to start over
          }
          inquirer.prompt(allPrompts.startOver(), function (answers) {
            analytics.add('start-over', answers['misc-start-over']);
            if (answers['misc-start-over']) {
              options['ignore-policy'] = true;
            }

            resolve();
          });
        });
      }).then(function () {
        return snyk.test(cwd, options).then(function (res) {
          var packageFile = path.resolve(cwd, 'package.json');

          if (!res.ok) {
            var vulns = res.vulnerabilities;
            // echo out the deps + vulns found
            console.log('Tested %s dependencies for known vulnerabilities, %s',
              res.dependencyCount,
              chalk.bold.red('found ' + vulns.length + ' vulnerabilities.'));
          } else {
            console.log(chalk.green('✓ Tested %s dependencies for known ' +
              'vulnerabilities, no vulnerabilities found.'),
              res.dependencyCount);
          }


          return tryRequire(packageFile).then(function (pkg) {
              return interactive(res, pkg, policy).then(function (answers) {
                return processAnswers(answers, policy, options);
              });
            });
        });
      });
    });
  });
}

function interactive(test, pkg, policy) {
  var vulns = test.vulnerabilities;
  if (!policy) {
    policy = {};
  }

  if (!pkg) { // only really happening in tests
    pkg = {};
  }

  return new Promise(function (resolve) {
    debug('starting questions');
    var prompts = allPrompts.getUpdatePrompts(vulns, policy);
    resolve(inquire(prompts, {}));
  }).then(function (answers) {
    var prompts = allPrompts.getPatchPrompts(vulns, policy);
    return inquire(prompts, answers);
  }).then(function (answers) {
    var prompts = allPrompts.getIgnorePrompts(vulns, policy);
    return inquire(prompts, answers);
  }).then(function (answers) {
    var prompts = allPrompts.nextSteps(pkg, test.ok ? false : answers);
    return inquire(prompts, answers);
  }).then(function (answers) {
    if (pkg.shrinkwrap) {
      answers['misc-build-shrinkwrap'] = true;
    }
    return answers;
  });
}

function inquire(prompts, answers) {
  if (prompts.length === 0) {
    return Promise.resolve(answers);
  }
  return new Promise(function (resolve) {
    inquirer.prompt(prompts, function (theseAnswers) {
      _.extend(answers, theseAnswers);
      resolve(answers);
    });
  });
}

function processAnswers(answers, policy, options) {
  if (!options) {
    options = {};
  }
  // allow us to capture the answers the users gave so we can combine this
  // the scenario running
  if (options.json) {
    return Promise.resolve(JSON.stringify(answers, '', 2));
  }

  var cwd = process.cwd();
  var packageFile = path.resolve(cwd, 'package.json');

  var tasks = {
    ignore: [],
    update: [],
    patch: [],
    skip: [],
  };

  var pkg = {};

  analytics.add('answers', Object.keys(answers).map(function (key) {
    // if we're looking at a reason, skip it
    if (key.indexOf('-reason') !== -1) {
      return;
    }

    // ignore misc questions, like "add snyk test to package?"
    if (key.indexOf('misc-') === 0) {
      return;
    }

    var answer = answers[key];
    var res = {
      vulnId: answer.vuln.id,
      choice: answer.choice,
    };

    if (answer.grouped && answer.grouped.main) {
      res.batch = true;
    }

    return res;
  }).filter(Boolean));

  Object.keys(answers).forEach(function (key) {
    // if we're looking at a reason, skip it
    if (key.indexOf('-reason') !== -1) {
      return;
    }

    // ignore misc questions, like "add snyk test to package?"
    if (key.indexOf('misc-') === 0) {
      return;
    }

    var answer = answers[key];
    var task = answer.choice;
    if (task === 'review' || task === 'skip') {
      // task = 'skip';
      return;
    }

    var vuln = answer.vuln;

    if (task === 'patch' && vuln.grouped && vuln.grouped.upgrades) {
      // ignore the first as it's the same one as this particular answer
      debug('additional answers required: %s',
        vuln.grouped.count - 1,
        vuln.grouped);

      var additional = vuln.grouped.upgrades.slice(1);

      additional.forEach(function (from) {
        var copy = _.cloneDeep(vuln);
        copy.from = from;
        tasks[task].push(copy);
      });
    }

    if (task === 'ignore') {
      answer.meta.reason = answers[key + '-reason'];
      tasks[task].push(answer);

      if (answer.meta.vulnsInGroup) {
        // also ignore any in the group
        answer.meta.vulnsInGroup.forEach(function (vuln) {
          if (vuln.id !== answer.vuln.id) {
            tasks[task].push({
              meta: answer.meta,
              vuln: vuln,
            });
          }
        });
      }
    } else {
      tasks[task].push(vuln);
    }
  });

  debug(tasks);

  var live = !options['dry-run'];
  var promise = protect.generatePolicy(policy, tasks, live);
  var snykVersion = '*';

  var res = promise.then(function (policy) {
    if (!live) {
      // if this was a dry run, we'll throw an error to bail out of the
      // promise chain, then in the catch, check the error.code and if
      // it matches `DRYRUN` we'll return the text and not an error
      // (which avoids the exit code 1).
      var e = new Error('This was a dry run: nothing changed');
      e.code = 'DRYRUN';
      throw e;
    }

    return snyk.policy.save(policy);
  })
  .then(function () {
    // re-read the package.json - because the generatePolicy can apply
    // an `npm install` which will change the deps
    return fs.readFile(packageFile, 'utf8')
      .then(JSON.parse)
      .then(function (updatedPkg) {
        pkg = updatedPkg;
      });
  })
  .then(getVersion)
  .then(function (v) {
    debug('snyk version: %s', v);
    // little hack to circumvent local testing where the version will
    // be the git branch + commit
    if (v.match(/^\d+\./) === null) {
      v = '*';
    } else {
      v = '^' + v;
    }
    snykVersion = v;
  })
  .then(function () {
    analytics.add('add-snyk-test', answers['misc-add-test']);
    if (!answers['misc-add-test']) {
      return;
    }

    debug('adding `snyk test` to package');

    if (!pkg.scripts) {
      pkg.scripts = {};
    }

    var test = pkg.scripts.test;
    var cmd = 'snyk test';
    if (test && test !== 'echo "Error: no test specified" && exit 1') {
      // only add the test if it's not already in the test
      if (test.indexOf(cmd) === -1) {
        pkg.scripts.test = cmd + ' && ' + test;
      }
    } else {
      pkg.scripts.test = cmd;
    }
  })
  .then(function () {
    analytics.add('add-snyk-protect', answers['misc-add-protect']);
    if (!answers['misc-add-protect']) {
      return;
    }

    debug('adding `snyk protect` to package');

    if (!pkg.scripts) {
      pkg.scripts = {};
    }

    pkg.scripts['snyk-protect'] = 'snyk protect';

    var cmd = 'npm run snyk-protect';
    var runScript = pkg.scripts.prepublish;
    if (runScript) {
      // only add the prepublish if it's not already in the prepublish
      if (runScript.indexOf(cmd) === -1) {
        pkg.scripts.prepublish = cmd + '; ' + runScript;
      }
    } else {
      pkg.scripts.prepublish = cmd;
    }

    // legacy check for `postinstall`, if `npm run snyk-protect` is in there
    // we'll replace it with `true` so it can be cleanly swapped out
    var postinstall = pkg.scripts.postinstall;
    if (postinstall && postinstall.indexOf(cmd) !== -1) {
      pkg.scripts.postinstall = postinstall.replace(cmd, 'true');
    }

    pkg.snyk = true;
  })
  .then(function () {
    if (answers['misc-add-test'] || answers['misc-add-protect']) {
      debug('updating %s', packageFile);

      var installPromise;

      if (undefsafe(pkg, 'dependencies.snyk') ||
          undefsafe(pkg, 'peerDependencies.snyk') ||
          undefsafe(pkg, 'optionalDependencies.snyk')) {
        installPromise = Promise.resolve(); // do nothing
      } else {
        installPromise = npm.bind(null, 'install', 'snyk', live, cwd);
      }

      // finally, add snyk as a dependency because they'll need it
      // during the protect process
      var lbl = 'Updating package.json...';
      return spinner(lbl)
        .then(fs.writeFile(packageFile, JSON.stringify(pkg, '', 2)))
        .then(installPromise)
        .then(spinner.clear(lbl));
    }
  })
  .then(function () {
    if (answers['misc-build-shrinkwrap'] && tasks.update.length) {
      debug('updating shrinkwrap');

      var lbl = 'Updating npm-shrinkwrap.json...';
      return spinner(lbl)
        .then(npm.bind(null, 'shrinkwrap', null, live, cwd))
        .then(spinner.clear(lbl));
    }
  })
  .then(function () {
    if (answers['misc-test-no-monitor']) { // allows us to automate tests
      return {
        id: 'test'
      };
    }

    debug('running monitor');
    var lbl = 'Remembering current dependencies for future ' +
      'notifications...';
    return snyk.modules(cwd)
      .then(spinner(lbl))
      .then(snyk.monitor.bind(null, cwd, {
        method: 'wizard',
      }))
      .then(spinner.clear(lbl));
  })
  .then(function (monitorRes) {
    var endpoint = url.parse(config.API);
    endpoint.pathname = '/monitor/' + monitorRes.id;

    return (options.newPolicy ?
      // if it's a newly created file
      '\nYour policy file has been created with the actions you\'ve ' +
        'selected, add it to your source control (`git add .snyk`).' :
      // otherwise we updated it
      '\nYour .snyk policy file has been successfully updated.') +
      '\nTo review your policy, run `snyk policy`.\n\n' +
      'You can see a snapshot of your dependencies here:\n' +
      url.format(endpoint) +
      '\n\nWe\'ll notify you when relevant new vulnerabilities are ' +
      'disclosed.';
  })
  .catch(function (error) {
    // if it's a dry run - exit with 0 status
    if (error.code === 'DRYRUN') {
      return error.message;
    }

    throw error;
  });

  return res;
}