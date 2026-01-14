#!/bin/bash

# Required parameters:
# @raycast.schemaVersion 1
# @raycast.title Kill Port
# @raycast.mode fullOutput

# Optional parameters:
# @raycast.icon 🔪
# @raycast.argument1 { "type": "text", "placeholder": "Port number (e.g. 8081)" }
# @raycast.packageName Developer Utils
# @raycast.needsConfirmation true

# Documentation:
# @raycast.description Kill what's running on port X with confirmation
# @raycast.author genesiscz
# @raycast.authorURL https://github.com/genesiscz

PORT="$1"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m' # No Color

# Validate port input
if [[ -z "$PORT" ]]; then
    echo -e "${RED}Error: Please provide a port number${NC}"
    exit 1
fi

if ! [[ "$PORT" =~ ^[0-9]+$ ]]; then
    echo -e "${RED}Error: Port must be a number${NC}"
    exit 1
fi

# Get PIDs listening on the port
PIDS=$(lsof -t -i :"$PORT" 2>/dev/null | sort -u)

if [[ -z "$PIDS" ]]; then
    echo -e "${YELLOW}No processes found on port ${BOLD}$PORT${NC}"
    exit 0
fi

echo -e "${BOLD}${CYAN}╔══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}${CYAN}║${NC}  ${BOLD}Processes running on port ${GREEN}$PORT${NC}                              ${BOLD}${CYAN}║${NC}"
echo -e "${BOLD}${CYAN}╚══════════════════════════════════════════════════════════════╝${NC}"
echo ""

# Get unique PIDs and display info for each
for PID in $PIDS; do
    # Get process info
    PROC_NAME=$(ps -p "$PID" -o comm= 2>/dev/null)
    PROC_CMD=$(ps -p "$PID" -o args= 2>/dev/null)
    PROC_USER=$(ps -p "$PID" -o user= 2>/dev/null)
    PROC_START=$(ps -p "$PID" -o lstart= 2>/dev/null)
    PROC_TIME=$(ps -p "$PID" -o etime= 2>/dev/null | xargs)
    PROC_MEM=$(ps -p "$PID" -o %mem= 2>/dev/null | xargs)
    PROC_CPU=$(ps -p "$PID" -o %cpu= 2>/dev/null | xargs)

    # Get parent process
    PPID_VAL=$(ps -p "$PID" -o ppid= 2>/dev/null | xargs)
    PARENT_NAME=$(ps -p "$PPID_VAL" -o comm= 2>/dev/null)

    echo -e "${BOLD}${BLUE}┌─────────────────────────────────────────────────────────────┐${NC}"
    echo -e "${BOLD}${BLUE}│${NC} ${BOLD}PID: ${GREEN}$PID${NC}  ${DIM}(${PROC_NAME})${NC}"
    echo -e "${BOLD}${BLUE}├─────────────────────────────────────────────────────────────┤${NC}"
    echo -e "${BLUE}│${NC} ${CYAN}User:${NC}     $PROC_USER"
    echo -e "${BLUE}│${NC} ${CYAN}Command:${NC}  ${DIM}$PROC_CMD${NC}"
    echo -e "${BLUE}│${NC} ${CYAN}Running:${NC}  $PROC_TIME"
    echo -e "${BLUE}│${NC} ${CYAN}CPU:${NC}      ${PROC_CPU}%  ${CYAN}MEM:${NC} ${PROC_MEM}%"
    if [[ -n "$PARENT_NAME" && "$PARENT_NAME" != "-" ]]; then
        echo -e "${BLUE}│${NC} ${CYAN}Parent:${NC}   $PARENT_NAME (PID: $PPID_VAL)"
    fi

    # Show child processes (tree)
    CHILDREN=$(pgrep -P "$PID" 2>/dev/null)
    if [[ -n "$CHILDREN" ]]; then
        echo -e "${BLUE}│${NC} ${CYAN}Children:${NC}"
        for CHILD in $CHILDREN; do
            CHILD_NAME=$(ps -p "$CHILD" -o comm= 2>/dev/null)
            echo -e "${BLUE}│${NC}   └── $CHILD_NAME (PID: $CHILD)"
        done
    fi
    echo -e "${BOLD}${BLUE}└─────────────────────────────────────────────────────────────┘${NC}"
    echo ""
done

# Count unique PIDs
PID_COUNT=$(echo "$PIDS" | wc -l | xargs)

echo -e "${YELLOW}Found ${BOLD}$PID_COUNT${NC}${YELLOW} process(es) on port ${BOLD}$PORT${NC}"
echo ""

# Ask for confirmation (skip if not interactive, e.g., Raycast)
if [[ -t 0 ]]; then
    echo -e -n "${BOLD}Kill these processes? ${NC}[${GREEN}y${NC}/${RED}N${NC}]: "
    read -r CONFIRM
    if [[ ! "$CONFIRM" =~ ^[Yy]$ ]]; then
        echo -e "${DIM}Aborted.${NC}"
        exit 0
    fi
else
    echo -e "${YELLOW}Non-interactive mode: proceeding without confirmation${NC}"
fi

# Kill processes gracefully (SIGTERM)
echo ""
echo -e "${YELLOW}Sending SIGTERM to processes...${NC}"

for PID in $PIDS; do
    kill "$PID" 2>/dev/null
    if [[ $? -eq 0 ]]; then
        echo -e "  ${GREEN}✓${NC} Sent SIGTERM to PID $PID"
    else
        echo -e "  ${RED}✗${NC} Failed to signal PID $PID"
    fi
done

# Wait a moment
echo -e "${DIM}Waiting 1.5 seconds...${NC}"
sleep 1.5

# Check if processes are still running
REMAINING_PIDS=""
for PID in $PIDS; do
    if kill -0 "$PID" 2>/dev/null; then
        REMAINING_PIDS="$REMAINING_PIDS $PID"
    fi
done

if [[ -z "$REMAINING_PIDS" ]]; then
    echo ""
    echo -e "${GREEN}${BOLD}✓ All processes terminated successfully!${NC}"
    echo -e "${DIM}Port $PORT is now free.${NC}"
    exit 0
fi

# Some processes still running
REMAINING_PIDS=$(echo "$REMAINING_PIDS" | xargs)
echo ""
echo -e "${RED}${BOLD}⚠ Some processes are still running:${NC}"
for PID in $REMAINING_PIDS; do
    PROC_NAME=$(ps -p "$PID" -o comm= 2>/dev/null)
    echo -e "  ${RED}•${NC} PID $PID ($PROC_NAME)"
done

echo ""
# Ask for force kill confirmation (auto-proceed if not interactive)
if [[ -t 0 ]]; then
    echo -e -n "${BOLD}Force kill (SIGKILL -9)? ${NC}[${GREEN}y${NC}/${RED}N${NC}]: "
    read -r FORCE_CONFIRM
    if [[ ! "$FORCE_CONFIRM" =~ ^[Yy]$ ]]; then
        echo -e "${DIM}Aborted. Processes may still be running.${NC}"
        exit 1
    fi
else
    echo -e "${YELLOW}Non-interactive mode: force killing remaining processes${NC}"
fi

# Force kill
echo ""
echo -e "${RED}Sending SIGKILL to remaining processes...${NC}"

for PID in $REMAINING_PIDS; do
    kill -9 "$PID" 2>/dev/null
    if [[ $? -eq 0 ]]; then
        echo -e "  ${GREEN}✓${NC} Force killed PID $PID"
    else
        echo -e "  ${RED}✗${NC} Failed to kill PID $PID"
    fi
done

# Final check
sleep 0.5
STILL_RUNNING=""
for PID in $REMAINING_PIDS; do
    if kill -0 "$PID" 2>/dev/null; then
        STILL_RUNNING="$STILL_RUNNING $PID"
    fi
done

if [[ -z "$STILL_RUNNING" ]]; then
    echo ""
    echo -e "${GREEN}${BOLD}✓ All processes terminated!${NC}"
    echo -e "${DIM}Port $PORT is now free.${NC}"
else
    echo ""
    echo -e "${RED}${BOLD}✗ Some processes could not be killed:${NC}"
    for PID in $STILL_RUNNING; do
        echo -e "  ${RED}•${NC} PID $PID"
    done
    echo -e "${DIM}You may need elevated privileges (sudo).${NC}"
    exit 1
fi
