#!/bin/zsh

# Required parameters:
# @raycast.schemaVersion 1
# @raycast.title Record Process
# @raycast.mode fullOutput

# Optional parameters:
# @raycast.icon 🤖
# @raycast.argument1 { "type": "text", "placeholder": "PID", "placeholder": "Enter process ID" }
# @raycast.argument2 { "type": "text", "placeholder": "Interval (sec)", "placeholder": "Enter recording interval in seconds" }
# @raycast.argument3 { "type": "text", "placeholder": "Duration (sec)", "placeholder": "Enter recording duration in seconds" }
# @raycast.packageName Developer Utils

# Documentation:
# @raycast.description PSRecord
# @raycast.author genesiscz
# @raycast.authorURL https://github.com/genesiscz

# Get arguments from Raycast
export PATH="$HOME/.local/bin:$PATH";

echo "PATH: $PATH, HOMEDIR: $HOME";
PID=$1
INTERVAL=$2
DURATION=$3
OUTPUT_IMAGE="psrecord_${PID}_$(date +%Y%m%d_%H%M%S).png" # Generate a unique filename

# Check if psrecord is installed
if ! command -v psrecord &> /dev/null
then
    echo "Error: psrecord is not installed. Please install it using 'pip install psrecord'."
    exit 1
fi

# Run psrecord
echo "Running: psrecord $PID --interval $INTERVAL --duration $DURATION --plot $OUTPUT_IMAGE"
psrecord "$PID" --interval "$INTERVAL" --duration "$DURATION" --plot "$OUTPUT_IMAGE"

# Check if the command was successful
if [ $? -eq 0 ]; then
    echo "psrecord finished. Plot saved to: $(pwd)/$OUTPUT_IMAGE"
    # Open the generated image file
    open "./$OUTPUT_IMAGE"
else
    echo "Error running psrecord. Please check the PID, interval, and duration."
fi
