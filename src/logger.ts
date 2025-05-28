import log from 'loglevel';
import type { LogLevelNames, LogLevelDesc } from 'loglevel';
import minimist from 'minimist';

const args = minimist(process.argv.slice(2));

// Default level
let level: LogLevelDesc = 'info';

if (args.vv) {
    level = 'trace';
} else if (args.v) {
    level = 'debug';
}

// Store the original factory
// const originalFactory = log.methodFactory;

// log.methodFactory = (methodName: LogLevelNames, logLevel: log.LogLevelNumbers, loggerName?: string | symbol) => {
//     const rawMethod = originalFactory(methodName, logLevel, loggerName as string);

//     // Redirect info, debug, and trace to stderr. Warn and error already go to stderr by default.
//     if (methodName === 'info' || methodName === 'debug' || methodName === 'trace') {
//         return (...messages: any[]) => {
//             console.error(...messages);
//         };
//     }
//     // For 'warn' and 'error', use the original method which directs to stderr.
//     return rawMethod;
// };

log.setLevel(level); // Apply the new factory and level

export default log; 