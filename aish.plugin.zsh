# aish - AI Shell Integration for Zsh
# Press Ctrl+G to convert natural language to shell commands

# Check if aish is installed
if ! command -v aish &>/dev/null; then
  print -P "%F{yellow}[aish]%f aish command not found. Install with: npm install -g aish-cli"
  return 1
fi

# History file
AISH_HISTFILE="${AISH_HISTFILE:-$HOME/.aish_history}"
AISH_HISTSIZE="${AISH_HISTSIZE:-100}"

# Shared state
typeset -g _aish_input_query=""

# Load history into array
typeset -ga _aish_history
_aish_load_history() {
  _aish_history=()
  [[ -f "$AISH_HISTFILE" ]] && _aish_history=("${(@f)$(< "$AISH_HISTFILE")}")
}

_aish_save_history() {
  local entry="$1"
  [[ -z "$entry" ]] && return
  _aish_history=("${(@)_aish_history:#$entry}")
  _aish_history+=("$entry")
  while (( ${#_aish_history} > AISH_HISTSIZE )); do
    shift _aish_history
  done
  printf '%s\n' "${_aish_history[@]}" > "$AISH_HISTFILE"
}

_aish_load_history

# Fill placeholders like <message>, <url>, etc.
# Sets _aish_input_query with result, returns 1 if cancelled
_aish_fill_placeholders() {
  local cmd="$1"
  local result="$cmd"

  # Find all unique placeholders
  local placeholders=()
  local seen=()
  while [[ "$result" =~ '<([^>]+)>' ]]; do
    local match="${MATCH}"
    local name="${match:1:-1}"

    # Check if already seen
    local found=0
    for s in "${seen[@]}"; do
      [[ "$s" == "$match" ]] && found=1 && break
    done

    if (( !found )); then
      seen+=("$match")
      placeholders+=("$match:$name")
    fi

    # Move past this match
    result="${result#*$match}"
  done

  result="$cmd"

  # If no placeholders, return as-is
  if (( ${#placeholders[@]} == 0 )); then
    _aish_input_query="$cmd"
    return 0
  fi

  # Prompt for each placeholder
  local total=${#placeholders[@]}
  local current=0

  for entry in "${placeholders[@]}"; do
    (( current++ ))
    local placeholder="${entry%%:*}"
    local name="${entry#*:}"

    # Read the value with inline display
    local value=""
    local vcursor=0
    local char

    # Helper to update display with current value
    _aish_placeholder_display() {
      # Replace first occurrence of placeholder with value for display
      local before="${result%%$placeholder*}"
      local after="${result#*$placeholder}"
      local display_val="$value"
      [[ -z "$display_val" ]] && display_val="$placeholder"

      BUFFER="${before}${display_val}${after}"
      CURSOR=$(( ${#before} + vcursor ))

      POSTDISPLAY=$'\n  '"$name ($current/$total)"'  │  enter: continue  │  esc: cancel'
      region_highlight=()

      # Highlight the value/placeholder area
      local start=${#before}
      local end=$(( start + ${#display_val} ))
      if [[ -z "$value" ]]; then
        region_highlight+=("${start} ${end} fg=yellow,bold")
      else
        region_highlight+=("${start} ${end} fg=green")
      fi

      # Dim the hint text
      local hint_start=${#BUFFER}
      local hint_end=$(( hint_start + ${#POSTDISPLAY} ))
      region_highlight+=("${hint_start} ${hint_end} fg=8")

      zle -R
    }

    _aish_placeholder_display

    while read -k1 char; do
      # Handle escape sequences (arrow keys)
      if [[ "$char" == $'\e' ]]; then
        read -k1 -t 0.1 char2
        if [[ "$char2" == '[' ]]; then
          read -k1 -t 0.1 char3
          case "$char3" in
            C) (( vcursor < ${#value} )) && (( vcursor++ )) ;;  # Right
            D) (( vcursor > 0 )) && (( vcursor-- )) ;;          # Left
          esac
          _aish_placeholder_display
          continue
        else
          # Escape key - cancel
          _aish_input_query=""
          POSTDISPLAY=""
          return 1
        fi
      fi

      case "$char" in
        $'\n'|$'\r')
          break ;;
        $'\x7f'|$'\b')
          if (( vcursor > 0 )); then
            value="${value:0:$((vcursor-1))}${value:$vcursor}"
            (( vcursor-- ))
          fi ;;
        $'\x03')
          _aish_input_query=""
          POSTDISPLAY=""
          return 1 ;;
        $'\x01') vcursor=0 ;;           # Ctrl+A
        $'\x05') vcursor=${#value} ;;   # Ctrl+E
        *)
          value="${value:0:$vcursor}${char}${value:$vcursor}"
          (( vcursor++ )) ;;
      esac
      _aish_placeholder_display
    done

    unset -f _aish_placeholder_display

    # Cancel if empty value
    if [[ -z "$value" ]]; then
      _aish_input_query=""
      POSTDISPLAY=""
      return 1
    fi

    # Replace all occurrences of this placeholder
    result="${result//$placeholder/$value}"
  done

  POSTDISPLAY=""
  _aish_input_query="$result"
  return 0
}

_aish_update_display() {
  local prefix="$1"
  local query="$2"
  local qcursor="$3"

  BUFFER="${prefix}${query}"
  CURSOR=$(( ${#prefix} + qcursor ))
  region_highlight=("0 ${#prefix} fg=magenta,bold")
  zle -R
}

_aish_read_input() {
  local prefix="$1"
  local initial_query="${2:-}"

  local query="$initial_query"
  local qcursor=${#query}
  local char
  local hist_idx=$(( ${#_aish_history} + 1 ))
  local saved_query=""

  _aish_update_display "$prefix" "$query" "$qcursor"

  while read -k1 char; do
    if [[ "$char" == $'\e' ]]; then
      read -k1 -t 0.1 char2
      if [[ "$char2" == '[' ]]; then
        read -k1 -t 0.1 char3
        case "$char3" in
          A) # Up
            if (( hist_idx > 1 )); then
              (( hist_idx == ${#_aish_history} + 1 )) && saved_query="$query"
              (( hist_idx-- ))
              query="${_aish_history[$hist_idx]}"
              qcursor=${#query}
            fi ;;
          B) # Down
            if (( hist_idx <= ${#_aish_history} )); then
              (( hist_idx++ ))
              if (( hist_idx > ${#_aish_history} )); then
                query="$saved_query"
              else
                query="${_aish_history[$hist_idx]}"
              fi
              qcursor=${#query}
            fi ;;
          C) (( qcursor < ${#query} )) && (( qcursor++ )) ;;
          D) (( qcursor > 0 )) && (( qcursor-- )) ;;
        esac
        _aish_update_display "$prefix" "$query" "$qcursor"
        continue
      else
        _aish_input_query=""
        return 1
      fi
    fi

    case "$char" in
      $'\n'|$'\r')
        _aish_input_query="$query"
        return 0 ;;
      $'\x7f'|$'\b')
        if (( qcursor > 0 )); then
          query="${query:0:$((qcursor-1))}${query:$qcursor}"
          (( qcursor-- ))
        fi ;;
      $'\x03')
        _aish_input_query=""
        return 1 ;;
      $'\x01') qcursor=0 ;;
      $'\x05') qcursor=${#query} ;;
      $'\x15') query=""; qcursor=0 ;;
      *)
        query="${query:0:$qcursor}${char}${query:$qcursor}"
        (( qcursor++ ))
        hist_idx=$(( ${#_aish_history} + 1 )) ;;
    esac
    _aish_update_display "$prefix" "$query" "$qcursor"
  done
}

_aish_widget() {
  setopt LOCAL_OPTIONS NO_NOTIFY NO_MONITOR

  local cmd
  local saved_buffer="$BUFFER"
  local saved_cursor="$CURSOR"
  local saved_region_highlight=("${region_highlight[@]}")
  local context=""

  while true; do
    local prefix="AI› "
    [[ -n "$context" ]] && prefix="AI+ "

    if ! _aish_read_input "$prefix" ""; then
      region_highlight=("${saved_region_highlight[@]}")
      BUFFER="$saved_buffer"
      CURSOR="$saved_cursor"
      zle -R
      return
    fi

    local query="$_aish_input_query"

    if [[ -z "$query" ]]; then
      region_highlight=("${saved_region_highlight[@]}")
      BUFFER="$saved_buffer"
      CURSOR="$saved_cursor"
      zle -R
      return
    fi

    # Build query with context
    local full_query="$query"
    if [[ -n "$context" ]]; then
      full_query="Previous conversation:
${context}

User's new request: $query

Respond with only the updated command."
    fi

    # Show spinner in buffer while loading
    local spinner='⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
    local spin_i=0
    local tmpfile=$(mktemp)
    local errfile=$(mktemp)

    # Hide cursor
    print -n $'\e[?25l'

    aish --print "$full_query" > "$tmpfile" 2>"$errfile" &
    local pid=$!

    while kill -0 $pid 2>/dev/null; do
      local spin_char="${spinner:$spin_i:1}"
      BUFFER="${prefix}${query} ${spin_char}"
      CURSOR=${#BUFFER}
      region_highlight=("0 ${#prefix} fg=magenta,bold")
      zle -R
      spin_i=$(( (spin_i + 1) % 10 ))
      sleep 0.08
    done

    # Show cursor
    print -n $'\e[?25h'

    wait $pid 2>/dev/null
    local exit_code=$?
    cmd=$(<"$tmpfile")
    local errmsg=$(<"$errfile")
    rm -f "$tmpfile" "$errfile"

    if [[ $exit_code -ne 0 ]]; then
      # Show error briefly
      BUFFER=""
      POSTDISPLAY=$'\n  '"Error: ${errmsg:-aish command failed}"
      region_highlight=()
      zle -R
      sleep 2
      POSTDISPLAY=""
      region_highlight=("${saved_region_highlight[@]}")
      BUFFER="$saved_buffer"
      CURSOR="$saved_cursor"
      zle -R
      return
    fi

    if [[ -n "$cmd" ]]; then
      _aish_save_history "$query"

      # Fill placeholders if any
      if ! _aish_fill_placeholders "$cmd"; then
        # Cancelled during placeholder fill
        region_highlight=("${saved_region_highlight[@]}")
        BUFFER="$saved_buffer"
        CURSOR="$saved_cursor"
        zle -R
        return
      fi
      cmd="$_aish_input_query"

      if [[ -n "$context" ]]; then
        context="${context}

User refinement: ${query}
Command: ${cmd}"
      else
        context="User request: ${query}
Command: ${cmd}"
      fi

      # Show result with hints
      BUFFER="$cmd"
      CURSOR=${#BUFFER}
      local hints=$'\n  tab: refine  │  enter: accept  │  esc: cancel'
      POSTDISPLAY="$hints"
      # Highlight POSTDISPLAY area (starts after BUFFER)
      local hint_start=${#BUFFER}
      local hint_end=$(( hint_start + ${#hints} ))
      region_highlight=("${saved_region_highlight[@]}" "${hint_start} ${hint_end} fg=8")
      zle -R

      # Wait for user choice - read into REPLY (no variable assignment shown)
      zle -R
      read -sk1

      # Clear hints
      POSTDISPLAY=""

      # Handle key based on REPLY
      if [[ "$REPLY" == $'\t' ]]; then
        # Tab - refine
        BUFFER=""
        CURSOR=0
        zle -R
        continue
      elif [[ "$REPLY" == $'\e' ]]; then
        region_highlight=("${saved_region_highlight[@]}")
        BUFFER="$saved_buffer"
        CURSOR="$saved_cursor"
        zle -R
        return
      elif [[ "$REPLY" == $'\n' || "$REPLY" == $'\r' ]]; then
        return
      else
        [[ "$REPLY" == [[:print:]] ]] && BUFFER="${cmd}${REPLY}" && CURSOR=${#BUFFER}
        return
      fi
    else
      region_highlight=("${saved_region_highlight[@]}")
      BUFFER="$saved_buffer"
      CURSOR="$saved_cursor"
      zle -R
      return
    fi
  done
}

zle -N _aish_widget
bindkey '^G' _aish_widget
