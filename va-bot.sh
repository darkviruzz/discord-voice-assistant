#!/bin/bash
set -e

cd /home/discordbot/discord-voice-assistant

echo "Fetching latest (pruning stale)..."
git fetch --prune >/dev/null 2>&1

CURRENT_BRANCH=$(git branch --show-current 2>/dev/null || echo "")
DIRTY=$(git status --porcelain 2>/dev/null | grep -v '^??' | wc -l)

declare -A local_hash local_subject remote_hash remote_subject

while IFS='|' read -r name hash subject; do
    [[ "$name" =~ ^\(HEAD ]] && continue
    local_hash["$name"]="${hash:0:7}"
    local_subject["$name"]="$subject"
done < <(git branch --format='%(refname:short)|%(objectname:short)|%(subject)')

while IFS='|' read -r name hash subject; do
    [[ "$name" == "origin/HEAD" ]] && continue
    [[ "$name" == "origin" ]] && continue
    name="${name#origin/}"
    [[ -z "$name" ]] && continue
    remote_hash["$name"]="${hash:0:7}"
    remote_subject["$name"]="$subject"
done < <(git branch -r --format='%(refname:short)|%(objectname:short)|%(subject)')

declare -a all_names
while IFS= read -r name; do
    all_names+=("$name")
done < <(printf '%s\n' "${!local_hash[@]}" "${!remote_hash[@]}" | sort -u)

if [ ${#all_names[@]} -eq 0 ]; then
    echo "Keine Branches gefunden."
    read -rsn1
    exit 1
fi

selected=0
for i in "${!all_names[@]}"; do
    if [[ "${all_names[$i]}" == "$CURRENT_BRANCH" ]]; then
        selected=$i
        break
    fi
done

stty_save=$(stty -g)
cleanup() {
    stty "$stty_save"
    tput cnorm
    echo
}
trap cleanup EXIT

tput civis
stty -echo -icanon min 1 time 0

draw() {
    clear
    printf "  \033[36mSELECT BRANCH TO DEPLOY\033[0m\n"
    printf "  \033[2m[L/R]   L=lokal  R=remote  *=uncommitted changes  <=aktiv\033[0m\n"
    printf "  \033[2m[up/down] navigate  [Enter] select  [Q] quit\033[0m\n\n"

    for i in "${!all_names[@]}"; do
        name="${all_names[$i]}"
        hasL=0; hasR=0
        [[ -n "${local_hash[$name]+x}" ]]  && hasL=1
        [[ -n "${remote_hash[$name]+x}" ]] && hasR=1
        hash="${local_hash[$name]:-${remote_hash[$name]}}"
        subject="${local_subject[$name]:-${remote_subject[$name]}}"

        L=" "; R=" "
        [[ $hasL -eq 1 ]] && L="L"
        [[ $hasR -eq 1 ]] && R="R"

        dChar=" "
        aChar=" "
        [[ "$name" == "$CURRENT_BRANCH" && "$DIRTY" -gt 0 ]] && dChar="*"
        [[ "$name" == "$CURRENT_BRANCH" ]] && aChar="<"

        line="  [$L/$R]$dChar$aChar  $(printf '%-45s' "$name") $hash  $subject"

        if [ "$i" -eq "$selected" ]; then
            printf "\033[1;33m> %s\033[0m\n" "$line"
        elif [[ "$name" == "$CURRENT_BRANCH" ]]; then
            printf "\033[36m  %s\033[0m\n" "$line"
        else
            printf "\033[2m  %s\033[0m\n" "$line"
        fi
    done
}

done_selecting=0
while [ $done_selecting -eq 0 ]; do
    draw

    IFS= read -rsn1 key

    if [[ "$key" == $'\x1b' ]]; then
        IFS= read -rsn1 -t 0.1 key2
        if [[ "$key2" == '[' ]]; then
            IFS= read -rsn1 -t 0.1 key3
            case "$key3" in
                'A') [ "$selected" -gt 0 ] && selected=$((selected - 1)) || true ;;
                'B') [ "$selected" -lt $((${#all_names[@]} - 1)) ] && selected=$((selected + 1)) || true ;;
            esac
        fi
    elif [[ "$key" == '' ]]; then
        done_selecting=1
    elif [[ "$key" == [Qq] ]]; then
        exit 0
    fi
done

stty "$stty_save"
tput cnorm

chosen="${all_names[$selected]}"
hasL=0; hasR=0
[[ -n "${local_hash[$chosen]+x}" ]]  && hasL=1
[[ -n "${remote_hash[$chosen]+x}" ]] && hasR=1

echo ""
echo -e "\033[32mSelected: $chosen @ ${local_hash[$chosen]:-${remote_hash[$chosen]}}\033[0m"

if [[ "$chosen" == "$CURRENT_BRANCH" ]]; then
    echo "Branch unveraendert - starte Bot neu..."
    sudo systemctl restart discord-bot.service
    echo "Bot gestartet (systemctl restart discord-bot.service)"
    exit 0
fi

if [ "$DIRTY" -gt 0 ]; then
    stash_label="auto: vor checkout zu $chosen ($(date '+%Y-%m-%d %H:%M'))"
    echo "Stashing uncommitted changes..."
    git stash push -m "$stash_label" >/dev/null 2>&1
    echo "  Wiederherstellen wenn zurueck auf '$CURRENT_BRANCH': git stash pop"
fi

echo "Stopping bot..."
sudo systemctl stop discord-bot.service 2>/dev/null || true
sleep 1

if [ $hasL -eq 1 ]; then
    git checkout --quiet "$chosen"
else
    git checkout --quiet -b "$chosen" --track "origin/$chosen"
fi

if [ $? -ne 0 ]; then
    echo -e "\033[31mFehler beim Checkout von '$chosen'.\033[0m"
    read -rsn1
    exit 1
fi

if [ $hasR -eq 1 ]; then
    if ! git pull --quiet origin "$chosen" 2>&1; then
        echo -e "\033[31mWARNUNG: git pull fehlgeschlagen.\033[0m"
        read -rsn1
        exit 1
    fi
else
    echo "  Kein Remote-Branch - kein pull."
fi

echo "Starting bot..."
sudo systemctl start discord-bot.service
echo "Bot gestartet (systemctl start discord-bot.service)"
