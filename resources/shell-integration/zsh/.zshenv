# Project Lanes - zsh 用 .zshenv
# ZDOTDIR 切替で本ファイルが zsh の起動経路で最初に読まれる
# 役割: 元の ZDOTDIR の .zshenv を委譲ロードする (環境変数の整合維持)
[[ -n "$LANES_ORIG_ZDOTDIR" && -r "$LANES_ORIG_ZDOTDIR/.zshenv" ]] && source "$LANES_ORIG_ZDOTDIR/.zshenv"
