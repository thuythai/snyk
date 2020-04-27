import { test } from 'tap';
import cli = require('../src/cli/commands');

import { fakeServer } from './acceptance/fake-server';
import { getVersion } from '../src/lib/version';

const apiKey = '123456789';

const port = (process.env.PORT = process.env.SNYK_PORT = '12345');
const BASE_API = '/api/v1';
let oldkey;
let oldendpoint;
let versionNumber;
const server = fakeServer(BASE_API, apiKey);

test('setup', async (t) => {
  versionNumber = await getVersion();
  let key = await cli.config('get', 'api');
  oldkey = key;
  t.pass('existing user config captured');

  key = await cli.config('get', 'endpoint');
  oldendpoint = key;
  t.pass('existing user endpoint captured');

  await new Promise((resolve) => {
    server.listen(port, resolve);
  });
  t.pass('started demo server');
});

test('"snyk test --severity-threshold=high"', async (t) => {
  const options = { severityThreshold: 'high' };

  try {
    await cli.test('ionic@1.6.5', options);
  } catch (error) {
    const req = server.popRequest();
    t.match(
      req,
      'severityThreshold=high',
      'severity threshold is passed as a query param',
    );
  }
});

test('"snyk test --severity-threshold=non-sense"', async (t) => {
  const options = { severityThreshold: 'non-sense' };
  try {
    await cli.test('ionic@1.6.5', options);
  } catch (error) {
    t.equal(
      error.message,
      'INVALID_SEVERITY_THRESHOLD',
      'non-existing severity level is caught',
    );
  }
});

test('teardown', async (t) => {
  await new Promise((resolve) => {
    server.close(resolve);
  });
  t.pass('server shutdown');
  let key = 'set';
  let value = 'api=' + oldkey;
  if (!oldkey) {
    key = 'unset';
    value = 'api';
  }
  await cli.config(key, value);
  t.pass('user config restored');
  if (oldendpoint) {
    await cli.config('endpoint', oldendpoint);
    t.pass('user endpoint restored');
  } else {
    t.pass('no endpoint');
  }
});
