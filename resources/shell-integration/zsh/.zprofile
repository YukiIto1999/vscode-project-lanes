# Project Lanes - zsh 用 .zprofile (login shell 用)
if [[ -n "$LANES_ORIG_ZDOTDIR" && -r "$LANES_ORIG_ZDOTDIR/.zprofile" ]]; then
    ZDOTDIR="$LANES_ORIG_ZDOTDIR"
    source "$ZDOTDIR/.zprofile"
    ZDOTDIR="$LANES_ZDOTDIR"
fi
