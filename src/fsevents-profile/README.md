# FSEvents Profile

A profiling tool that monitors file system events using macOS fsevents. Helps identify directories with high filesystem activity to diagnose performance issues or find cache/build directories.

## CLI Usage

```bash
# Monitor entire filesystem for default 15 seconds
tools fsevents-profile

# Monitor specific directory
tools fsevents-profile /Users

# Monitor for custom duration
tools fsevents-profile -d 30

# Show top 5 directories instead of default 10
tools fsevents-profile -t 5 /tmp

# Show processes currently watching fsevents (requires root)
sudo tools fsevents-profile --watchers

# Enable verbose logging to see events in real-time
tools fsevents-profile -v /Users/Martin
```

Options:

-   `--duration, -d`: Monitoring duration in seconds (default: 15)
-   `--top, -t`: Number of top directories to display (default: 10)
-   `[path]`: Path to monitor as positional argument (default: "/")
-   `--watchers, -w`: Show processes currently watching fsevents (requires root)
-   `--verbose, -v`: Enable verbose logging to see events as they occur
-   `-?, --help-full`: Show extended help message

## How It Works

1. Starts an fsevents watcher on the specified path
2. Collects all file system events during the monitoring period
3. Aggregates events by parent directory
4. Displays the top N directories with the most activity
5. Press Ctrl+C at any time to stop early and see results

## Examples

```bash
# Quick check of home directory
tools fsevents-profile ~

# Extended monitoring of project directory
tools fsevents-profile -d 60 -t 20 ./my-project

# Find what processes are using fsevents
sudo tools fsevents-profile --watchers
```

## Notes

-   The tool uses native macOS fsevents API for efficient filesystem monitoring
-   Results are sorted by event count to help identify problematic directories
-   Common high-activity locations include: caches, build outputs, cloud sync folders
-   The `--watchers` flag requires root privileges to run `fs_usage`
-   Monitoring the root filesystem (`/`) may generate a large number of events
