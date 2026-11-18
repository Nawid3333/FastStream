// Starts a suite's own test server on its fixed port, or stops the whole run.
//
// wdio only logs an onPrepare error and runs every spec anyway: with the port taken (another run,
// WSL's verify:linux) the specs would test that run's build.

/**
 * Listens on 127.0.0.1:port, or ends the process with the reason.
 * @param {import('node:http').Server} server - The suite's server.
 * @param {number} port - Its fixed port.
 * @param {function(): void} resolve - Called once it listens.
 */
export function listenOrStop(server, port, resolve) {
  server.on('error', (error) => {
    console.error(error.code === 'EADDRINUSE' ?
      `\nPort ${port} is already in use, most likely by another test run on this machine ` +
        '(another checkout, or verify:linux in WSL). Its server would answer these specs, ' +
        'so the run stops here.\n' :
      `\nThe test server on port ${port} failed: ${error.message}\n`);
    process.exit(1);
  });
  server.listen(port, '127.0.0.1', resolve);
}
