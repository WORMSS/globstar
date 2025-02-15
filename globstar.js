#!/usr/bin/env node
'use strict';
var path = require('path');
var EOL = require('os').EOL;
var format = require('util').format;
var spawn = require('child_process').spawn;
var npmlog = require('npmlog');
var glob = require('glob').sync;
var onetime = require('onetime');
var isGlob = require('is-glob');
var objectAssign = require('object-assign');
var packageJson = require('./package.json');
var yargs = require('yargs')
  .scriptName('globstar')
  .usage(
    [
      'Run programs with globstar support.',
      '',
      'Usage: $0 [OPTION]... -- COMMAND [ARG]... ',
      'Note the -- between the $0 OPTIONS and the COMMAND and its arguments',
    ].join(EOL)
  )
  .demand(1, 'COMMAND required')
  // nodir
  .boolean('nodir')
  .describe('nodir', 'glob patterns do not match directories, only files')
  // ignore
  .array('i')
  .alias('i', 'ignore')
  .describe('i', 'add glob pattern to exclude from matches')
  // node
  .boolean('n')
  .alias('n', 'node')
  .describe('n', 'same as `--ignore "**/node_modules/**"`')
  // verbose
  .count('v')
  .alias('v', 'verbose')
  .describe('v', 'explain what is being done')
  // each
  .boolean('e')
  .alias('e', 'each')
  .describe('e', 'run COMMAND on each value')
  // version
  .version(packageJson.version)
  // help
  .help('help')
  // epilog
  .epilog(
    [
      `Report $0 bugs to <${packageJson.bugs.url}>`,
      `$0 home page: <${packageJson.homepage}>`
    ].join(EOL)
  );

function parseArgv(argv) {
  var err = null;
  var args = yargs
    .fail(function yargsFail(message) {
      err = new Error(message);
      err.name = 'YargsError';
    })
    .parse(argv);

  // set defaults
  args = objectAssign(
    {
      _: [],
      $0: path.relative(process.cwd(), __filename),
      verbose: 0,
    },
    args
  );

  // translate args
  args.verbose = 2 - Math.max(2 - args.verbose, 0); // 0 <= verbose <= 2
  npmlog.level = ['info', 'verbose', 'silly'][args.verbose];

  if (args.node) {
    args.ignore = args.ignore || [];
    args.ignore.push('**/node_modules/**');
  }

  // setup result
  var result = err || {};
  result.logLevel = ['info', 'verbose', 'silly'][args.verbose];
  result.each = args.each;
  result.cmd = args._[0];
  result.args = args._.slice(1);
  result.$0 = args.$0;
  result.globOpts = args;

  Object.keys(result.globOpts)
    .filter(function nonGlobFlag(opt) {
      switch (opt) {
        case '$0':
        case 'verbose':
        case 'each':
        case 'node':
          return true;
        default:
          return opt.length === 1;
      }
    })
    .forEach(function deleteFlag(flag) {
      delete result.globOpts[flag];
    });

  return result;
}

function globArgs(args, globOpts) {
  globOpts.nonull = true; // override --no-null etc.

  npmlog.log('silly', 'globstar', { opts: globOpts });

  return args
    .map(function globArg(arg) {
      return glob(arg, globOpts);
    })
    .reduce(function flatten(previous, current) {
      return previous.concat(current);
    }, []);
}

/**
 * @param {string[]} args
 * @param {*} globOpts
 */
function globArgsEach(args, globOpts) {
  globOpts.nonull = true; // override --no-null etc.

  npmlog.log('silly', 'globstar', { opts: globOpts });
  const globCount = args.reduce((prev, curr) => prev + isGlob(curr, { strict: false }), 0);
  if (globCount > 1) {
    throw new Error('each cannot accept multiple globs');
  }
  if (globCount <= 0) {
    return [args];
  }
  const globIndex = args.findIndex((arg) => isGlob(arg));
  const globValues = glob(args[globIndex], globOpts);
  return globValues.map((value) => {
    const newArgs = [...args];
    newArgs[globIndex] = value;
    return newArgs;
  });
}

function spawnCommand(cmd, args, cb) {
  cb = onetime(cb);

  var opts = {
    stdio: 'inherit',
  };

  /* istanbul ignore next: platform specific */
  if (process.platform === 'win32') {
    args = ['/c', '"' + cmd + '"'].concat(args);
    cmd = 'cmd';
    opts.windowsVerbatimArguments = true;
  }

  npmlog.log('verbose', 'globstar', 'Running: `' + cmd + '` ' + format(args));

  var child = spawn(cmd, args, opts);
  child.on('error', cb);
  child.on('close', function onClose(status) {
    if (status) {
      var err = new Error('Exit status ' + status);
      err.name = 'SpawnError';
      err.status = status;
      cb(err);
    } else {
      cb();
    }
  });
}

function main(argv, exit) {
  function errorHandler(err) {
    if (err) {
      if (err.name !== 'SpawnError') {
        if (npmlog.level === 'silly') {
          npmlog.log('error', 'globstar', err);
        } else {
          npmlog.log('error', 'globstar', err.message);
        }
        npmlog.log('info', 'globstar', `Try '${argv.$0} --help' for more information`);
        npmlog.log('verbose', 'globstar@' + packageJson.version);
      }

      exit(err.status || 1);
      return;
    }
    exit(0);
  }

  argv = parseArgv(argv);

  if (argv instanceof Error) {
    errorHandler(argv);
    return;
  }

  if (argv.each) {
    mainEach(argv, errorHandler);
    return;
  }
  spawnCommand(argv.cmd, globArgs(argv.args, argv.globOpts), errorHandler);
}

async function mainEach(argv, errorHandler) {
  try {
    const values = globArgsEach(argv.args, argv.globOpts);
    for (const value of values) {
      await new Promise((resolve, reject) => {
        spawnCommand(argv.cmd, value, (err) => (err ? reject(err) : resolve()));
      });
    }
  } catch (err) {
    errorHandler(err);
  }
}

module.exports = main;

/* istanbul ignore if: coverd by test.js (fs.spawn) */
if (require.main === module) {
  main(process.argv.slice(2), process.exit.bind(process));
}
