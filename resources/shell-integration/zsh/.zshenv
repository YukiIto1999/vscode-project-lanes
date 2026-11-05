# Project Lanes - zsh 用 .zshenv
# ZDOTDIR 切替で本ファイルが zsh の起動経路で最初に読まれる
# 役割: 元の ZDOTDIR の .zshenv を委譲ロードする (環境変数の整合維持)
LANES_ZDOTDIR="$ZDOTDIR"
if [[ -n "$LANES_ORIG_ZDOTDIR" ]]; then
    # ユーザーの dotfiles からは元の ZDOTDIR が見えるよう、委譲ロード中だけ戻す
    ZDOTDIR="$LANES_ORIG_ZDOTDIR"
    [[ "$ZDOTDIR" != "$LANES_ZDOTDIR" && -r "$ZDOTDIR/.zshenv" ]] && source "$ZDOTDIR/.zshenv"
    # .zshenv が ZDOTDIR を変えた場合 (XDG 配置など) は、以降の委譲先も追従
    LANES_ORIG_ZDOTDIR="$ZDOTDIR"
    ZDOTDIR="$LANES_ZDOTDIR"
fi
