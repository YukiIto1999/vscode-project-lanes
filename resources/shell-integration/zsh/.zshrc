# Project Lanes - zsh 用 .zshrc
# 役割: 元の .zshrc を委譲ロードした後、コマンド実行境界を OSC 633 で通知する

[[ -n "$LANES_ORIG_ZDOTDIR" && -r "$LANES_ORIG_ZDOTDIR/.zshrc" ]] && source "$LANES_ORIG_ZDOTDIR/.zshrc"

# 入れ子 zsh が元の dotfiles を読むよう ZDOTDIR を復元
if [[ -n "$LANES_ORIG_ZDOTDIR" ]]; then
    export ZDOTDIR="$LANES_ORIG_ZDOTDIR"
fi

__lanes_osc() { builtin print -n "\033]633;$1\007" }

typeset -g __lanes_first=1
__lanes_precmd() {
    local status=$?
    if (( __lanes_first )); then
        __lanes_first=0
    else
        __lanes_osc "D;$status"
    fi
    __lanes_osc "A"
}

__lanes_preexec() {
    __lanes_osc "C"
}

autoload -Uz add-zsh-hook
add-zsh-hook precmd __lanes_precmd
add-zsh-hook preexec __lanes_preexec

# プロンプト末尾に B (非印字マーカー)
PS1="$PS1"$'%{\033]633;B\007%}'
