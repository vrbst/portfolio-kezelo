// Import FIRST in the handler: tg-hub reads the response from stdout, so any
// console output (ours or a library's) must go to stderr, into the hub's log.

for (const k of ["log", "info", "debug"] as const) console[k] = console.error;
