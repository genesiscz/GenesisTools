import log from 'loglevel';
import type { LogLevelDesc } from 'loglevel';
import minimist from 'minimist';

const args = minimist(process.argv.slice(2));

// Default level
let level: LogLevelDesc = 'info';

if (args.vv) {
    level = 'trace';
} else if (args.v) {
    level = 'debug';
}

log.setLevel(level);

export default log; 