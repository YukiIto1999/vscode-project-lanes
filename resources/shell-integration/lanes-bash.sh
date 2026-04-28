# Project Lanes - bash 用シェル統合スクリプト (OSC 633)
# 起動: bash --rcfile <this>
# 役割: ユーザーの通常 rc を読み込んだ後、コマンド実行境界を OSC 633 で通知する

# 既存 rc の読み込み (--rcfile 指定時は /etc/bash.bashrc と ~/.bashrc が読まれない)
[[ -r /etc/bash.bashrc ]] && . /etc/bash.bashrc
[[ -r "$HOME/.bashrc" ]] && . "$HOME/.bashrc"

# Bash 4.4+ 必須 (PS0 を擬似 preexec として利用)
if (( BASH_VERSINFO[0] < 4 )) || { (( BASH_VERSINFO[0] == 4 )) && (( BASH_VERSINFO[1] < 4 )); }; then
    return 0
fi

__lanes_osc() { builtin printf '\033]633;%s\007' "$1"; }

__lanes_first=1
__lanes_precmd() {
    local status=$?
    if (( __lanes_first )); then
        __lanes_first=0
    else
        __lanes_osc "D;$status"
    fi
    __lanes_osc "A"
}

# PS1 末尾に B (プロンプト終端 = コマンド開始位置) を非印字マーカーで追加
PS1="$PS1"'\[\033]633;B\007\]'

# PS0 先頭に C (コマンド実行直前) を追加
PS0=$'\033]633;C\007'"${PS0:-}"

# PROMPT_COMMAND の先頭に precmd を追加 (配列形式 / 文字列形式の両対応)
if [[ "$(declare -p PROMPT_COMMAND 2>/dev/null)" == "declare -a"* ]]; then
    PROMPT_COMMAND=("__lanes_precmd" "${PROMPT_COMMAND[@]}")
else
    PROMPT_COMMAND="__lanes_precmd${PROMPT_COMMAND:+; $PROMPT_COMMAND}"
fi
