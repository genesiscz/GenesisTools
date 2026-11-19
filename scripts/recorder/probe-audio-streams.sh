#!/bin/sh
# Run on a native recording and a frames proxy made with the same sound inputs enabled.
set -eu
if [ "$#" -ne 2 ]; then
    echo "Usage: sh $0 MOVIE_RECORDING FRAMES_PROXY" >&2
    exit 2
fi

printf '%s\n' 'Movie recording'
ffprobe -v error -select_streams a -show_streams -of json -i "$1"
printf '%s\n' 'Frames proxy'
ffprobe -v error -select_streams a -show_streams -of json -i "$2"
