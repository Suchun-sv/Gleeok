#!/usr/bin/env bash
# SHELL for README recordings: a plain bash with a neutral prompt (no hostname, no user rc files).
# In a directory holding .demo-cmd it shows that command at the prompt and runs it, as if typed.
export PS1='\[\e[32m\]➜\[\e[0m\]  \[\e[36m\]\W\[\e[0m\] ' HISTFILE=/dev/null
rc=$(mktemp)
cat >"$rc" <<'RC'
if [ -f .demo-cmd ]; then
  cmd=$(cat .demo-cmd)
  printf '\e[32m➜\e[0m  \e[36m%s\e[0m %s\n' "${PWD##*/}" "$cmd"
  eval "$cmd"
fi
RC
exec bash --noprofile --rcfile "$rc" -i
