const directions = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0], wait: [0, 0] };
const dirLabels = { up: '上', down: '下', left: '左', right: '右', wait: '待機' };

export class StarGarden {
    constructor() {
        this.size = 9;
        this.player = { x: 1, y: 4 };
        this.target = { x: 7, y: 2 };
        this.blocks = [
            { x: 3, y: 1 }, { x: 3, y: 2 }, { x: 3, y: 3 },
            { x: 5, y: 4 }, { x: 5, y: 5 }, { x: 5, y: 6 },
            { x: 2, y: 6 }, { x: 6, y: 1 }
        ];
        this.revision = 0;
        this.score = 0;
        this.steps = 0;
        this.lastAction = null;
        this.justGotStar = false;
        this.paused = false;
    }

    can(x, y) {
        return x >= 0 && y >= 0 && x < this.size && y < this.size && !this.blocks.some(b => b.x === x && b.y === y);
    }

    distance() {
        return Math.abs(this.player.x - this.target.x) + Math.abs(this.player.y - this.target.y);
    }

    observe() {
        const legal = Object.entries(directions)
            .filter(([k, [dx, dy]]) => k !== 'wait' && this.can(this.player.x + dx, this.player.y + dy))
            .map(([k]) => k);
        return {
            name: 'Star Garden',
            // Facts the host may state about the game: the adapter, not the model, is the source of truth.
            title: '星集めパズル', goal: 'ブロックを避けて星を集める一人用のパズル',
            size: this.size,
            player: { ...this.player },
            target: { ...this.target },
            blocks: this.blocks.map(x => ({ ...x })),
            score: this.score,
            steps: this.steps,
            revision: this.revision,
            distance: this.distance(),
            lastAction: this.lastAction,
            justGotStar: this.justGotStar,
            paused: this.paused,
            legal,
            summary: this.situation()
        };
    }

    situation() {
        const dist = this.distance();
        if (this.justGotStar) {
            return `星を獲得しました！現在のスコアは${this.score}点です。新しい星が現れました。`;
        }
        if (dist === 1) {
            return `星のすぐ隣（あと1手）まで来ました！`;
        }
        if (dist <= 3) {
            return `星まであと${dist}手。近づいてきました。`;
        }
        const lastDir = dirLabels[this.lastAction] || '';
        return `星まであと${dist}手。${lastDir ? lastDir + 'へ移動しながら' : ''}障害物を避けて進んでいます。スコア:${this.score}点。`;
    }

    act(action, revision) {
        if (this.paused) return false;
        if (revision !== undefined && revision !== this.revision) return false;
        if (!Object.hasOwn(directions, action)) return false;

        const [dx, dy] = directions[action];
        const x = this.player.x + dx;
        const y = this.player.y + dy;
        if (!this.can(x, y)) return false;

        this.player = { x, y };
        this.revision++;
        this.steps++;
        this.lastAction = action;

        if (x === this.target.x && y === this.target.y) {
            this.score++;
            this.justGotStar = true;
            const targets = [{ x: 1, y: 7 }, { x: 7, y: 7 }, { x: 1, y: 1 }, { x: 7, y: 2 }, { x: 4, y: 7 }, { x: 7, y: 4 }];
            this.target = { ...targets[(this.score - 1) % targets.length] };
        } else {
            this.justGotStar = false;
        }
        return true;
    }

    step(preferredAction = null) {
        if (this.paused) return { acted: false, observation: this.observe() };
        const action = preferredAction && this.can(this.player.x + directions[preferredAction]?.[0], this.player.y + directions[preferredAction]?.[1])
            ? preferredAction
            : this.demoMove();
        const ok = this.act(action, this.revision);
        return { acted: ok, action, observation: this.observe() };
    }

    pause() {
        this.paused = true;
    }

    resume() {
        this.paused = false;
    }

    demoMove() {
        const queue = [{ ...this.player, first: null }];
        const seen = new Set([`${this.player.x},${this.player.y}`]);
        while (queue.length) {
            const n = queue.shift();
            if (n.x === this.target.x && n.y === this.target.y) {
                return n.first || 'wait';
            }
            for (const [key, [dx, dy]] of Object.entries(directions)) {
                if (key === 'wait') continue;
                const x = n.x + dx, y = n.y + dy, hash = `${x},${y}`;
                if (this.can(x, y) && !seen.has(hash)) {
                    seen.add(hash);
                    queue.push({ x, y, first: n.first || key });
                }
            }
        }
        return 'wait';
    }
}
