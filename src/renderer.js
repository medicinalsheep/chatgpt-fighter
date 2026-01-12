/* chatGPT fighter - renderer
   Pure HTML/CSS/JS deterministic lockstep fighter with P2P WebRTC DataChannel.

   NOTE: Manual Offer/Answer copy/paste signaling means no backend needed.
*/

(() => {
    // -----------------------------
    // Utilities
    // -----------------------------
    const $ = (sel) => document.querySelector(sel);
    const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
    const now = () => performance.now();

    function safeJsonParse(text) {
        try { return { ok: true, value: JSON.parse(text) }; }
        catch (e) { return { ok: false, error: String(e?.message || e) }; }
    }

    async function copyToClipboard(text) {
        await navigator.clipboard.writeText(text);
    }

    function fmtPct(x) { return `${Math.round(clamp(x, 0, 1) * 100)}%`; }

    // -----------------------------
    // Storage
    // -----------------------------
    const Storage = {
        get(key, fallback = null) {
            try {
                const raw = localStorage.getItem(key);
                if (raw == null) return fallback;
                return JSON.parse(raw);
            } catch {
                return fallback;
            }
        },
        set(key, value) {
            localStorage.setItem(key, JSON.stringify(value));
        },
        del(key) { localStorage.removeItem(key); }
    };

    const KEYS = {
        username: "cgf_username",
        chars: "cgf_characters",
        activeCharId: "cgf_activeCharId",
        settings: "cgf_settings"
    };

    // -----------------------------
    // Settings
    // -----------------------------
    const DefaultSettings = {
        volume: 0.6,
        music: true,
        sfx: true,
        inputDelayFrames: 2
    };

    let settings = { ...DefaultSettings, ...(Storage.get(KEYS.settings, {}) || {}) };

    function saveSettings() {
        Storage.set(KEYS.settings, settings);
        Audio.setMaster(settings.volume);
        Audio.setEnabled(settings.music, settings.sfx);
        UI.updateSettingsLabels();
    }

    // -----------------------------
    // Character System (spec-driven)
    // -----------------------------
    const CharacterSpec = {
        version: 1,
        budget: 34,
        statMin: 3,
        statMax: 9,
        // "cost" = stat value (simple). Budget enforces fairness.
        // Total = sum of all 7 stats must be <= budget.
        stats: ["health", "attack", "defense", "speed", "jump", "special", "range"],
        palettes: ["#66e3ff", "#a5ff7a", "#ff5a7a", "#ffce5a", "#c9a7ff", "#7af0d1", "#ffffff"]
    };

    function makeCharId() {
        return "c_" + Math.random().toString(16).slice(2) + Date.now().toString(16);
    }

    function listCharacters() {
        return Storage.get(KEYS.chars, []);
    }

    function saveCharacters(chars) {
        Storage.set(KEYS.chars, chars);
    }

    function getActiveCharId() {
        return Storage.get(KEYS.activeCharId, null);
    }

    function setActiveCharId(id) {
        Storage.set(KEYS.activeCharId, id);
    }

    function validateAndNormalizeCharacter(raw) {
        // Validate strict shape, clamp stats, enforce budget.
        const errors = [];
        if (!raw || typeof raw !== "object") errors.push("Root must be a JSON object.");

        const version = raw?.version;
        if (version !== 1) errors.push(`"version" must be 1.`);

        const name = String(raw?.name ?? "").trim();
        if (!name) errors.push(`"name" is required.`);
        if (name.length > 20) errors.push(`"name" must be <= 20 chars.`);

        const tagline = String(raw?.tagline ?? "").trim();
        if (!tagline) errors.push(`"tagline" is required.`);
        if (tagline.length > 80) errors.push(`"tagline" must be <= 80 chars.`);

        const palette = raw?.palette;
        const primary = String(palette?.primary ?? "").trim();
        const secondary = String(palette?.secondary ?? "").trim();
        function isHex(c) { return /^#([0-9a-fA-F]{6})$/.test(c); }
        if (!isHex(primary)) errors.push(`palette.primary must be hex like "#66e3ff".`);
        if (!isHex(secondary)) errors.push(`palette.secondary must be hex like "#a5ff7a".`);

        const stats = raw?.stats;
        if (!stats || typeof stats !== "object") errors.push(`"stats" must be an object.`);
        const normStats = {};
        let sum = 0;
        for (const k of CharacterSpec.stats) {
            let v = Number(stats?.[k]);
            if (!Number.isFinite(v)) errors.push(`stats.${k} must be a number.`);
            v = Math.round(v);
            v = clamp(v, CharacterSpec.statMin, CharacterSpec.statMax);
            normStats[k] = v;
            sum += v;
        }
        if (sum > CharacterSpec.budget) {
            errors.push(
                `Stat budget exceeded: sum=${sum}, budget=${CharacterSpec.budget}. ` +
                `Lower some stats. (Min ${CharacterSpec.statMin}, max ${CharacterSpec.statMax})`
            );
        }

        const moves = raw?.moves;
        if (!moves || typeof moves !== "object") errors.push(`"moves" must be an object.`);

        const specialName = String(moves?.specialName ?? "").trim();
        if (!specialName) errors.push(`moves.specialName is required.`);
        if (specialName.length > 18) errors.push(`moves.specialName must be <= 18 chars.`);

        let projectileSpeed = Number(moves?.projectileSpeed ?? 0);
        if (!Number.isFinite(projectileSpeed)) errors.push(`moves.projectileSpeed must be a number.`);
        projectileSpeed = Math.round(projectileSpeed);
        projectileSpeed = clamp(projectileSpeed, 6, 16); // deterministic fixed range

        let projectileSize = Number(moves?.projectileSize ?? 0);
        if (!Number.isFinite(projectileSize)) errors.push(`moves.projectileSize must be a number.`);
        projectileSize = Math.round(projectileSize);
        projectileSize = clamp(projectileSize, 8, 18);

        if (errors.length) {
            return { ok: false, errors };
        }

        // Normalize: ensure budget compliance by leaving as-is (already checked).
        const normalized = {
            version: 1,
            id: String(raw?.id || ""),
            name,
            tagline,
            palette: { primary, secondary },
            stats: normStats,
            moves: {
                specialName,
                projectileSpeed,
                projectileSize
            },
            meta: {
                createdAt: raw?.meta?.createdAt || new Date().toISOString(),
                authorHint: String(raw?.meta?.authorHint ?? "").slice(0, 40)
            }
        };

        return { ok: true, character: normalized, budgetSum: sum };
    }

    function derivedStats(stats) {
        // All integers
        return {
            maxHP: 900 + stats.health * 55,           // ~1065..1395
            atk: 8 + stats.attack * 2,                // 14..26
            def: 8 + stats.defense * 2,               // 14..26
            run: 220 + stats.speed * 18,              // (scaled later)
            jump: 520 + stats.jump * 20,              // (scaled later)
            meterGain: 8 + stats.special * 2,         // 14..26
            range: 18 + stats.range * 4,              // 30..54
            projBonus: stats.range                     // influences projectile damage modestly
        };
    }

    function characterSummaryText(c) {
        const d = derivedStats(c.stats);
        const sum = CharacterSpec.stats.reduce((acc, k) => acc + c.stats[k], 0);
        return [
            `Name: ${c.name}`,
            `Tagline: ${c.tagline}`,
            `Stats (sum ${sum}/${CharacterSpec.budget}):`,
            ...CharacterSpec.stats.map(k => `  ${k.padEnd(8)}: ${c.stats[k]}`),
            ``,
            `Derived:`,
            `  HP: ${d.maxHP}`,
            `  ATK: ${d.atk}  DEF: ${d.def}  RANGE: ${d.range}`,
            `  Special MeterGain: ${d.meterGain}`,
            `  Special: ${c.moves.specialName} (projSpeed=${c.moves.projectileSpeed}, size=${c.moves.projectileSize})`
        ].join("\n");
    }

    // -----------------------------
    // Prompt Generator
    // -----------------------------
    function buildPrompt({ archetype, theme, line }) {
        const guidance = {
            balanced: "Aim for rounded stats with no extremes.",
            rushdown: "Favor speed/jump/attack; keep range modest.",
            zoner: "Favor range/special; keep speed moderate.",
            grappler: "Favor health/attack/defense; keep speed/jump lower.",
            trickster: "Favor special + one other stat; keep within budget."
        }[archetype] || "Aim for fair, within-budget stats.";

        return `
You are generating a CHARACTER CODE for a 2D fighting game called "chatGPT fighter".
You MUST output ONLY valid JSON (no markdown, no code fences, no commentary).
The JSON MUST match this schema exactly:

{
  "version": 1,
  "name": "string (<=20 chars)",
  "tagline": "string (<=80 chars)",
  "palette": { "primary": "#RRGGBB", "secondary": "#RRGGBB" },
  "stats": {
    "health": integer ${CharacterSpec.statMin}-${CharacterSpec.statMax},
    "attack": integer ${CharacterSpec.statMin}-${CharacterSpec.statMax},
    "defense": integer ${CharacterSpec.statMin}-${CharacterSpec.statMax},
    "speed": integer ${CharacterSpec.statMin}-${CharacterSpec.statMax},
    "jump": integer ${CharacterSpec.statMin}-${CharacterSpec.statMax},
    "special": integer ${CharacterSpec.statMin}-${CharacterSpec.statMax},
    "range": integer ${CharacterSpec.statMin}-${CharacterSpec.statMax}
  },
  "moves": {
    "specialName": "string (<=18 chars)",
    "projectileSpeed": integer 6-16,
    "projectileSize": integer 8-18
  },
  "meta": {
    "authorHint": "string (<=40 chars)"
  }
}

FAIRNESS RULES (MANDATORY):
- Total stat budget: sum(health+attack+defense+speed+jump+special+range) MUST be <= ${CharacterSpec.budget}.
- All stats MUST be integers in range ${CharacterSpec.statMin}-${CharacterSpec.statMax}.
- Keep the character viable (no intentionally bad builds).
- Output ONLY the JSON object.

DESIGN INPUT:
- Archetype: ${archetype}
- Theme: ${theme || "(none provided)"}
- Personality one-liner: ${line || "(none provided)"}

BALANCE GUIDANCE:
- ${guidance}

Now output the JSON.`.trim();
    }

    // -----------------------------
    // Audio Engine (Web Audio API)
    // -----------------------------
    const Audio = (() => {
        let ctx = null;
        let master = null;
        let musicGain = null;
        let sfxGain = null;
        let musicOn = true;
        let sfxOn = true;
        let masterVol = 0.6;

        let musicTimer = null;
        let musicStep = 0;

        function ensure() {
            if (ctx) return;
            ctx = new (window.AudioContext || window.webkitAudioContext)();
            master = ctx.createGain();
            musicGain = ctx.createGain();
            sfxGain = ctx.createGain();
            musicGain.connect(master);
            sfxGain.connect(master);
            master.connect(ctx.destination);
            setMaster(masterVol);
            setEnabled(musicOn, sfxOn);
        }

        function setMaster(v) {
            masterVol = clamp(v, 0, 1);
            if (!master) return;
            master.gain.setValueAtTime(masterVol, ctx.currentTime);
        }

        function setEnabled(music, sfx) {
            musicOn = !!music;
            sfxOn = !!sfx;
            if (!musicGain || !sfxGain) return;
            musicGain.gain.setValueAtTime(musicOn ? 0.55 : 0.0, ctx.currentTime);
            sfxGain.gain.setValueAtTime(sfxOn ? 0.9 : 0.0, ctx.currentTime);
        }

        function beep({ freq = 440, dur = 0.08, type = "sine", gain = 0.12, detune = 0 }) {
            ensure();
            const t0 = ctx.currentTime;
            const osc = ctx.createOscillator();
            osc.type = type;
            osc.frequency.setValueAtTime(freq, t0);
            osc.detune.setValueAtTime(detune, t0);

            const g = ctx.createGain();
            g.gain.setValueAtTime(0.0001, t0);
            g.gain.exponentialRampToValueAtTime(gain, t0 + 0.01);
            g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

            osc.connect(g);
            g.connect(sfxGain);
            osc.start(t0);
            osc.stop(t0 + dur + 0.02);
        }

        function noiseHit() {
            ensure();
            const t0 = ctx.currentTime;
            const dur = 0.10;

            const bufferSize = Math.floor(ctx.sampleRate * dur);
            const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
            const data = buffer.getChannelData(0);
            for (let i = 0; i < bufferSize; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / bufferSize);

            const src = ctx.createBufferSource();
            src.buffer = buffer;

            const filter = ctx.createBiquadFilter();
            filter.type = "bandpass";
            filter.frequency.setValueAtTime(900, t0);
            filter.Q.setValueAtTime(2.5, t0);

            const g = ctx.createGain();
            g.gain.setValueAtTime(0.0001, t0);
            g.gain.exponentialRampToValueAtTime(0.2, t0 + 0.01);
            g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

            src.connect(filter);
            filter.connect(g);
            g.connect(sfxGain);

            src.start(t0);
            src.stop(t0 + dur + 0.02);
        }

        function startMusic() {
            ensure();
            stopMusic();
            if (!musicOn) return;

            const scale = [261.63, 293.66, 329.63, 392.00, 440.00, 523.25]; // C D E G A C
            const bass = [65.41, 73.42, 82.41, 98.00]; // C D E G (low)

            musicStep = 0;
            musicTimer = setInterval(() => {
                if (!ctx) return;
                if (!musicOn) return;

                const t = ctx.currentTime;
                const m = musicStep % 16;
                const chord = scale[(musicStep / 4) % scale.length | 0];

                // pad
                playTone(chord, 0.18, 0.25, "triangle", -7);
                playTone(chord * 2, 0.12, 0.25, "sine", 7);

                // bass on beats
                if (m % 4 === 0) {
                    const b = bass[(musicStep / 4) % bass.length | 0];
                    playTone(b, 0.22, 0.28, "square", -10);
                }

                musicStep++;
            }, 260);
        }

        function playTone(freq, gain, dur, type, detune = 0) {
            ensure();
            const t0 = ctx.currentTime;
            const osc = ctx.createOscillator();
            osc.type = type;
            osc.frequency.setValueAtTime(freq, t0);
            osc.detune.setValueAtTime(detune, t0);

            const g = ctx.createGain();
            g.gain.setValueAtTime(0.0001, t0);
            g.gain.exponentialRampToValueAtTime(gain, t0 + 0.02);
            g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

            osc.connect(g);
            g.connect(musicGain);
            osc.start(t0);
            osc.stop(t0 + dur + 0.02);
        }

        function stopMusic() {
            if (musicTimer) clearInterval(musicTimer);
            musicTimer = null;
        }

        function resumeIfSuspended() {
            ensure();
            if (ctx.state === "suspended") ctx.resume();
        }

        return {
            resumeIfSuspended,
            setMaster,
            setEnabled,
            startMusic,
            stopMusic,
            sfx: {
                ui: () => beep({ freq: 740, dur: 0.05, type: "sine", gain: 0.08 }),
                jump: () => beep({ freq: 520, dur: 0.08, type: "triangle", gain: 0.12 }),
                punch: () => beep({ freq: 250, dur: 0.06, type: "square", gain: 0.08, detune: -20 }),
                kick: () => beep({ freq: 180, dur: 0.07, type: "square", gain: 0.09 }),
                special: () => beep({ freq: 620, dur: 0.12, type: "sawtooth", gain: 0.10 }),
                hit: () => noiseHit(),
                ko: () => beep({ freq: 120, dur: 0.35, type: "sawtooth", gain: 0.16, detune: -40 })
            }
        };
    })();

    // -----------------------------
    // Networking (WebRTC DataChannel)
    // -----------------------------
    const Net = (() => {
        let pc = null;
        let dc = null;
        let isHost = false;

        let onOpen = () => { };
        let onClose = () => { };
        let onMessage = (msg) => { };
        let onStatus = (s) => { };

        const ICE_CONFIG = {
            // Public STUN. For many home NATs this is enough.
            iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
        };

        function setHandlers(h) {
            onOpen = h.onOpen || onOpen;
            onClose = h.onClose || onClose;
            onMessage = h.onMessage || onMessage;
            onStatus = h.onStatus || onStatus;
        }

        function status(s) { onStatus(s); }

        function reset() {
            if (dc) {
                try { dc.close(); } catch { }
                dc = null;
            }
            if (pc) {
                try { pc.close(); } catch { }
                pc = null;
            }
            isHost = false;
            status("idle");
        }

        function createPeer() {
            pc = new RTCPeerConnection(ICE_CONFIG);

            pc.oniceconnectionstatechange = () => {
                status(`ice:${pc.iceConnectionState}`);
                if (["failed", "disconnected", "closed"].includes(pc.iceConnectionState)) {
                    // Let UI decide; we also emit close if dc already closed.
                }
            };

            pc.onconnectionstatechange = () => {
                status(`conn:${pc.connectionState}`);
            };

            pc.ondatachannel = (ev) => {
                dc = ev.channel;
                hookDataChannel();
            };
        }

        function hookDataChannel() {
            if (!dc) return;
            dc.binaryType = "arraybuffer";

            dc.onopen = () => { status("datachannel:open"); onOpen(); };
            dc.onclose = () => { status("datachannel:closed"); onClose(); };
            dc.onerror = () => { status("datachannel:error"); };

            dc.onmessage = (ev) => {
                try {
                    const msg = JSON.parse(ev.data);
                    onMessage(msg);
                } catch {
                    // ignore malformed
                }
            };
        }

        function send(msg) {
            if (!dc || dc.readyState !== "open") return false;
            dc.send(JSON.stringify(msg));
            return true;
        }

        function waitIceGatheringComplete(peer) {
            return new Promise((resolve) => {
                if (peer.iceGatheringState === "complete") return resolve();
                const check = () => {
                    if (peer.iceGatheringState === "complete") {
                        peer.removeEventListener("icegatheringstatechange", check);
                        resolve();
                    }
                };
                peer.addEventListener("icegatheringstatechange", check);
            });
        }

        async function createOfferCode() {
            reset();
            isHost = true;
            createPeer();

            dc = pc.createDataChannel("cgf", { ordered: true });
            hookDataChannel();

            status("creating offer...");
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            await waitIceGatheringComplete(pc);

            const code = JSON.stringify({
                v: 1,
                type: pc.localDescription.type,
                sdp: pc.localDescription.sdp
            });

            status("offer ready");
            return code;
        }

        async function createAnswerCode(offerCode) {
            reset();
            isHost = false;
            createPeer();

            const parsed = safeJsonParse(offerCode);
            if (!parsed.ok) throw new Error("Offer code is not valid JSON.");
            const offer = parsed.value;
            if (offer?.v !== 1 || offer?.type !== "offer" || typeof offer?.sdp !== "string") {
                throw new Error("Offer code has invalid shape.");
            }

            status("setting remote offer...");
            await pc.setRemoteDescription({ type: "offer", sdp: offer.sdp });

            status("creating answer...");
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            await waitIceGatheringComplete(pc);

            const code = JSON.stringify({
                v: 1,
                type: pc.localDescription.type,
                sdp: pc.localDescription.sdp
            });

            status("answer ready");
            return code;
        }

        async function acceptAnswerCode(answerCode) {
            if (!pc) throw new Error("No host peer exists. Create an Offer first.");
            const parsed = safeJsonParse(answerCode);
            if (!parsed.ok) throw new Error("Answer code is not valid JSON.");
            const ans = parsed.value;
            if (ans?.v !== 1 || ans?.type !== "answer" || typeof ans?.sdp !== "string") {
                throw new Error("Answer code has invalid shape.");
            }

            status("accepting answer...");
            await pc.setRemoteDescription({ type: "answer", sdp: ans.sdp });
            status("connected (waiting datachannel)...");
        }

        return {
            setHandlers,
            reset,
            send,
            createOfferCode,
            createAnswerCode,
            acceptAnswerCode,
            isHost: () => isHost,
            ready: () => dc && dc.readyState === "open"
        };
    })();

    // -----------------------------
    // Deterministic Lockstep Fighter
    // -----------------------------
    const Game = (() => {
        // Fixed-point scaling
        const FP = 100; // 1 px = 100 units
        const ARENA_W = 1120;
        const ARENA_H = 520;
        const GROUND_Y = 420;

        const FIX_W = ARENA_W * FP;
        const FIX_GROUND = GROUND_Y * FP;

        // Frame rate
        const FPS = 60;
        const FRAME_MS = 1000 / FPS;

        // Input bitmask
        const IN = {
            L: 1 << 0,
            R: 1 << 1,
            J: 1 << 2,
            P: 1 << 3,
            K: 1 << 4,
            S: 1 << 5, // special
            B: 1 << 6  // block
        };

        // State
        let running = false;
        let lastTime = 0;
        let acc = 0;

        let seed = 1;
        let frame = 0;

        let localPlayerIndex = 0; // 0 or 1
        let inputDelay = settings.inputDelayFrames;

        const localKeyState = new Set();

        // input buffers
        const localInputs = new Map();  // frame -> mask
        const remoteInputs = new Map(); // frame -> mask

        // stall info
        let stalled = false;
        let stallFrames = 0;

        // canvas
        let canvas, ctx;

        // match objects
        let fighters = [];
        let projectiles = [];
        let particles = [];
        let hitstop = 0;
        let shake = 0;
        let winner = null;

        // Character load
        let p1 = null, p2 = null;
        let p1User = "P1", p2User = "P2";

        function xorshift32(x) {
            x |= 0;
            x ^= x << 13; x |= 0;
            x ^= x >>> 17; x |= 0;
            x ^= x << 5; x |= 0;
            return x | 0;
        }
        function rand01() {
            seed = xorshift32(seed);
            // unsigned -> [0,1)
            return ((seed >>> 0) / 4294967296);
        }

        function resetMatch({ seedIn, localIndex, p1Char, p2Char, p1Name, p2Name }) {
            seed = seedIn | 0;
            frame = 0;
            winner = null;

            localPlayerIndex = localIndex;
            inputDelay = settings.inputDelayFrames;

            localInputs.clear();
            remoteInputs.clear();

            for (let f = 0; f < inputDelay; f++) {
                localInputs.set(f, 0);
                Net.send({ t: "in", f, m: 0 });
            }

            stalled = false;
            stallFrames = 0;

            p1 = p1Char;
            p2 = p2Char;
            p1User = p1Name;
            p2User = p2Name;

            const d1 = derivedStats(p1.stats);
            const d2 = derivedStats(p2.stats);

            fighters = [
                makeFighter(0, 240 * FP, FIX_GROUND, p1, d1),
                makeFighter(1, 880 * FP, FIX_GROUND, p2, d2)
            ];

            // Facing
            fighters[0].facing = 1;
            fighters[1].facing = -1;

            projectiles = [];
            particles = [];
            hitstop = 0;
            shake = 0;

            UI.setHUDNames(p1User, p2User, p1.name, p2.name);
            UI.setRoundText("READY");
            setTimeout(() => UI.setRoundText("FIGHT"), 500);
            setTimeout(() => UI.setRoundText(""), 1400);
        }

        function makeFighter(i, x, y, char, d) {
            const viz = deriveVisuals(char);

            // Base sizes
            const baseW = 42 * FP;
            const baseH = 106 * FP;

            let w = baseW;
            let h = baseH;

            if (viz.silhouette === "bulky") {
                w += 10 * FP; h += 12 * FP;
            } else if (viz.silhouette === "nimble") {
                w -= 6 * FP; h -= 4 * FP;
            }

            // Slight stat influence (subtle, still readable)
            w += (char.stats.health - 5) * 2 * FP + (char.stats.defense - 5) * 1 * FP;
            w -= (char.stats.speed - 5) * 1 * FP;
            h += (char.stats.health - 5) * 2 * FP;
            h -= (char.stats.jump - 5) * 1 * FP;

            w = clamp(w, 34 * FP, 62 * FP);
            h = clamp(h, 90 * FP, 140 * FP);
            return {
                idx: i,
                char,
                d,

                x, y,
                vx: 0,
                vy: 0,

                w,
                h,
                viz,

                coyote: 0,
                jumpBuf: 0,

                onGround: true,
                facing: i === 0 ? 1 : -1,

                hp: d.maxHP,
                meter: 0,

                state: "idle", // idle, run, jump, punch, kick, special, hurt, ko, block
                stateFrame: 0,

                stun: 0,
                cooldown: 0,
                specialCD: 0,

                lastHitFrame: -9999
            };
        }

        function getHurtbox(f) {
            // Smaller than the drawn body so hits feel fair.
            // Also changes slightly by state (jump/hurt/ko).
            const w = f.w;
            const h = f.h;

            // Base padding (in fixed-point)
            let padX = Math.floor(w * 18 / 100);     // 18% narrower
            let padTop = 14 * FP;                   // head padding
            let padBottom = 10 * FP;                // feet padding

            if (f.state === "jump") {
                padX = Math.floor(w * 22 / 100);
                padBottom = 14 * FP;
            }
            if (f.state === "hurt") {
                padX = Math.floor(w * 24 / 100);
            }
            if (f.state === "ko") {
                padX = Math.floor(w * 28 / 100);
                padTop = 18 * FP;
            }

            const left = (f.x - w / 2) + padX;
            const top = (f.y - h) + padTop;
            const rw = w - padX * 2;
            const rh = h - padTop - padBottom;

            return { x: left, y: top, w: rw, h: rh };
        }

        function getHitbox(f) {
            // Returns a hitbox that starts at the fighter front edge.
            // The collision code later converts this into a world rect based on facing.
            const dir = f.facing;

            // Range and height tuned to feel better with the new hurtbox.
            const range = (f.d.range * FP);
            const frontX = f.x + dir * (f.w / 2 + 4 * FP);

            // Different vertical targets for different moves / states
            const midY = f.y - 72 * FP;
            const highY = f.y - 92 * FP;
            const lowY = f.y - 52 * FP;

            // Punch: quick, mid/high
            if (f.state === "punch" && f.stateFrame >= 4 && f.stateFrame <= 6) {
                const y = (f.onGround ? midY : highY);
                return {
                    x: frontX,
                    y,
                    w: Math.floor(range * 0.90),
                    h: 20 * FP,
                    dmg: 24,
                    type: "punch"
                };
            }

            // Kick: slower, wider + slightly lower
            if (f.state === "kick" && f.stateFrame >= 6 && f.stateFrame <= 9) {
                return {
                    x: frontX,
                    y: lowY,
                    w: range + 10 * FP,
                    h: 26 * FP,
                    dmg: 32,
                    type: "kick"
                };
            }

            return null;
        }

        function aabb(a, b) {
            return (
                a.x < b.x + b.w &&
                a.x + a.w > b.x &&
                a.y < b.y + b.h &&
                a.y + a.h > b.y
            );
        }

        function hurtboxRect(f) {
            const hb = getHurtbox(f);
            return hb;
        }

        function applyDamage(attacker, defender, baseDmg, kind) {
            const atk = attacker.d.atk;
            const def = defender.d.def;

            const atkMul = 100 + 3 * (atk - 14);
            const defMul = 100 + 2 * (def - 14);

            let dmg = Math.floor((baseDmg * atkMul) / defMul);

            const isBlocking = defender.state === "block";
            if (isBlocking) {
                const mult = (kind === "projectile") ? 0.25 : 0.35;
                dmg = Math.floor(dmg * mult);
            }
            dmg = clamp(dmg, 1, 120);

            defender.hp = Math.max(0, defender.hp - dmg);

            // meter gain
            const gain = attacker.d.meterGain;
            attacker.meter = clamp(attacker.meter + gain, 0, 100);
            defender.meter = clamp(defender.meter + Math.floor(gain / 3), 0, 100);

            // stun + state
            if (!isBlocking) {
                const stunFrames =
                    (kind === "kick") ? 14 :
                        (kind === "projectile") ? 12 :
                            10;

                defender.stun = Math.max(defender.stun, stunFrames);
                defender.state = "hurt";
                defender.stateFrame = 0;
            } else {
                defender.state = "block";
                defender.stateFrame = 0;
            }

            // Knockback (improves readability and reduces overlap)
            const dir = attacker.facing; // -1 or 1

            // Knockback speed in px/sec-ish terms mapped to per-frame FP velocity
            let kb =
                (kind === "kick") ? 540 :
                    (kind === "punch") ? 440 :
                        480;

            kb += (attacker.d.atk - 14) * 16; // scale with attack

            if (isBlocking) kb = Math.floor(kb * 0.35);

            const kbV = Math.floor((kb * FP) / 60); // convert to FP per frame
            defender.vx = dir * kbV;

            // Small pop-up only when not blocking and on ground
            if (!isBlocking && defender.onGround) {
                defender.vy = Math.min(defender.vy, -(520)); // ~5.2 px/frame upward
                defender.onGround = false;
            }

            // hitstop / shake / particles
            hitstop = Math.max(hitstop, isBlocking ? 2 : 4);
            shake = Math.max(shake, isBlocking ? 3 : 6);

            for (let i = 0; i < (isBlocking ? 4 : 7); i++) {
                particles.push(makeParticle(defender.x, defender.y - 70 * FP, attacker.char.palette.secondary));
            }

            Audio.sfx.hit();
        }

        function makeParticle(x, y, color) {
            // small deterministic particle using seeded rand
            const ang = Math.floor(rand01() * 628) / 100; // 0..6.28
            const sp = 180 + Math.floor(rand01() * 240);
            return {
                x, y,
                vx: Math.floor(Math.cos(ang) * sp) * FP / 100,
                vy: Math.floor(Math.sin(ang) * sp) * FP / 100,
                life: 18 + Math.floor(rand01() * 14),
                color
            };
        }

        function spawnProjectile(owner) {
            // Meter cost. If insufficient, do nothing.
            if (owner.meter < 35) return false;
            owner.meter -= 35;

            const dir = owner.facing;
            const spd = owner.char.moves.projectileSpeed; // 6..16
            const size = owner.char.moves.projectileSize; // 8..18
            const dmg = 18 + owner.d.projBonus; // modest

            const w = size * FP;
            const h = size * FP;

            const px = owner.x + dir * (owner.w / 2 + 18 * FP);
            const py = owner.y - 80 * FP;

            projectiles.push({
                ownerIdx: owner.idx,
                x: px,
                y: py,
                vx: dir * (spd * 36) * FP / 10,
                w,
                h,
                dmg,
                life: 70 + owner.char.stats.range * 6, // range affects travel time
                shape: owner.viz?.projShape || "orb",
                color: owner.char.palette.secondary
            });

            Audio.sfx.special();
            return true;
        }

        function getProjectileRect(p) {
            // Slightly smaller than drawn so it feels fair
            const w = Math.floor(p.w * 85 / 100);
            const h = Math.floor(p.h * 85 / 100);
            return { x: p.x - w / 2, y: p.y - h / 2, w, h };
        }

        function updateFacing() {
            const a = fighters[0], b = fighters[1];
            if (a.x < b.x) { a.facing = 1; b.facing = -1; }
            else { a.facing = -1; b.facing = 1; }
        }

        function stepLogic(inputMasks) {
            // inputMasks: [maskP1, maskP2]
            if (winner) return;

            if (hitstop > 0) {
                hitstop--;
                return; // hitstop freezes simulation
            }

            // Update fighters
            for (let i = 0; i < 2; i++) {
                const f = fighters[i];
                const opp = fighters[1 - i];
                const m = inputMasks[i] | 0;

                // KO transition
                if (f.hp <= 0 && f.state !== "ko") {
                    f.state = "ko";
                    f.stateFrame = 0;
                    f.stun = 0;
                    f.vx = 0;
                }

                // Cooldowns / stun
                if (f.cooldown > 0) f.cooldown--;
                if (f.specialCD > 0) f.specialCD--;
                if (f.stun > 0) f.stun--;

                // Jump feel helpers: coyote + buffer
                if (f.onGround) f.coyote = 6;
                else f.coyote = Math.max(0, f.coyote - 1);

                f.jumpBuf = Math.max(0, f.jumpBuf - 1);
                if (m & IN.J) f.jumpBuf = 6;

                const canAct = (f.state !== "ko" && f.stun === 0);

                // Determine current state flags FIRST (movement uses inAttack)
                const inAttack = (f.state === "punch" || f.state === "kick" || f.state === "special");
                const inHurt = (f.state === "hurt");
                const inBlock = (f.state === "block");

                // Block (only on ground)
                const wantsBlock = !!(m & IN.B) && f.onGround && canAct && !inHurt;
                if (wantsBlock) {
                    if (f.state !== "block") {
                        f.state = "block";
                        f.stateFrame = 0;
                    }
                } else if (f.state === "block") {
                    f.state = "idle";
                    f.stateFrame = 0;
                }

                // Actions (only if not already attacking/hurt/block)
                if (canAct && !inAttack && !inHurt && f.state !== "block") {
                    // Jump (buffer + coyote)
                    if (f.jumpBuf > 0 && f.coyote > 0) {
                        f.vy = -(1100 + f.char.stats.jump * 110); // tuned for your integrateFighter gravity
                        f.onGround = false;
                        f.state = "jump";
                        f.stateFrame = 0;

                        // IMPORTANT: clear jump buffer once it triggers
                        f.jumpBuf = 0;
                        f.coyote = 0;

                        Audio.sfx.jump();
                    }

                    // Attacks
                    if ((m & IN.P) && f.cooldown === 0) {
                        f.state = "punch";
                        f.stateFrame = 0;
                        f.cooldown = 10;
                        Audio.sfx.punch();
                    } else if ((m & IN.K) && f.cooldown === 0) {
                        f.state = "kick";
                        f.stateFrame = 0;
                        f.cooldown = 14;
                        Audio.sfx.kick();
                    } else if ((m & IN.S) && f.specialCD === 0) {
                        f.state = "special";
                        f.stateFrame = 0;
                        f.specialCD = 26;
                    }
                }

                // Recompute inAttack after potential state change above
                const inAttack2 = (f.state === "punch" || f.state === "kick" || f.state === "special");

                // Horizontal movement (after inAttack is defined)
                const canMove = (f.state !== "ko" && f.state !== "hurt" && f.state !== "block" && !inAttack2);
                if (canMove) {
                    const left = !!(m & IN.L);
                    const right = !!(m & IN.R);

                    let dir = 0;
                    if (left && !right) dir = -1;
                    if (right && !left) dir = 1;

                    const speedRating = f.d.run; // ~274..382

                    const maxGround = Math.floor((520 + speedRating * 2) * FP / 60); // ~12..16 px/frame
                    const maxAir = Math.floor(maxGround * 85 / 100);

                    const accelGround = Math.floor(maxGround * 28 / 100);
                    const accelAir = Math.floor(maxAir * 18 / 100);

                    const maxV = f.onGround ? maxGround : maxAir;
                    const accel = f.onGround ? accelGround : accelAir;

                    if (dir !== 0) {
                        f.vx = clamp(f.vx + dir * accel, -maxV, maxV);
                        if (f.onGround && f.state !== "jump") f.state = "run";
                    } else {
                        if (f.onGround && f.state === "run") f.state = "idle";
                    }
                }

                // Advance animation frame
                f.stateFrame++;

                // Hurt end
                if (f.state === "hurt" && f.stateFrame > 12) {
                    f.state = f.onGround ? "idle" : "jump";
                    f.stateFrame = 0;
                }

                // Jump land
                if (f.state === "jump" && f.onGround && f.stateFrame > 2) {
                    f.state = "idle";
                    f.stateFrame = 0;
                }

                // Attack end
                if (f.state === "punch" && f.stateFrame > 12) {
                    f.state = f.onGround ? "idle" : "jump";
                    f.stateFrame = 0;
                }
                if (f.state === "kick" && f.stateFrame > 16) {
                    f.state = f.onGround ? "idle" : "jump";
                    f.stateFrame = 0;
                }

                // Special timing (spawn projectile on frame 8)
                if (f.state === "special") {
                    if (f.stateFrame === 8) {
                        const spawned = spawnProjectile(f);
                        if (spawned) {
                            // small recoil for feel / spacing (deterministic)
                            f.vx = Math.floor(f.vx * 60 / 100) - f.facing * (6 * FP);
                        }
                    }
                    if (f.stateFrame > 18) {
                        f.state = f.onGround ? "idle" : "jump";
                        f.stateFrame = 0;
                    }
                }

                // Integrate after logic
                integrateFighter(f);

                // Soft push apart to prevent overlap
                const hb = getHurtbox(f);
                const ob = getHurtbox(opp);
                if (aabb(hb, ob)) {
                    const push = 8 * FP;
                    if (f.x < opp.x) { f.x -= push; opp.x += push; }
                    else { f.x += push; opp.x -= push; }
                }
            }

            updateFacing();

            // Melee hits (after both updated)
            for (let i = 0; i < 2; i++) {
                const a = fighters[i];
                const b = fighters[1 - i];

                const hit = getHitbox(a);
                if (!hit) continue;
                if (a.lastHitFrame === frame) continue;

                const hitRect = {
                    x: hit.x + (a.facing === 1 ? 0 : -hit.w),
                    y: hit.y,
                    w: hit.w,
                    h: hit.h
                };

                const hurt = hurtboxRect(b);

                const verticalClose = Math.abs(a.y - b.y) < 140 * FP;
                if (verticalClose && aabb(hitRect, hurt) && b.state !== "ko") {
                    a.lastHitFrame = frame;
                    applyDamage(a, b, hit.dmg, hit.type);
                }
            }

            // Projectiles
            for (let pi = projectiles.length - 1; pi >= 0; pi--) {
                const p = projectiles[pi];
                p.x += p.vx;
                p.life--;

                const pr = getProjectileRect(p);

                if (p.life <= 0 || pr.x < -80 * FP || pr.x > FIX_W + 80 * FP) {
                    projectiles.splice(pi, 1);
                    continue;
                }

                const target = fighters[1 - p.ownerIdx];
                if (target.state === "ko") continue;

                const tr = hurtboxRect(target);
                if (aabb(pr, tr)) {
                    const owner = fighters[p.ownerIdx];
                    applyDamage(owner, target, p.dmg, "projectile");
                    projectiles.splice(pi, 1);
                }
            }

            // Particles
            for (let i = particles.length - 1; i >= 0; i--) {
                const pt = particles[i];
                pt.x += pt.vx;
                pt.y += pt.vy;
                pt.vy += 40 * FP;
                pt.life--;
                if (pt.life <= 0) particles.splice(i, 1);
            }

            // KO check
            if (fighters[0].hp <= 0 || fighters[1].hp <= 0) {
                winner = fighters[0].hp > 0 ? 0 : fighters[1].hp > 0 ? 1 : null;
                UI.setRoundText(winner == null ? "DRAW" : (winner === 0 ? "P1 WINS" : "P2 WINS"));
                UI.setSyncText("");
                Audio.sfx.ko();
                setTimeout(() => {
                    stop();
                    const youWin = (winner != null && winner === localPlayerIndex);
                    UI.showResult({
                        title: winner == null ? "Draw" : (youWin ? "Victory" : "Defeat"),
                        sub: winner == null ? "Double KO." : (youWin ? "Clean work." : "Run it back.")
                    });
                }, 900);
            }
        }
        function buildLocalInputMask() {
            let m = 0;
            if (localKeyState.has("KeyA")) m |= IN.L;
            if (localKeyState.has("KeyD")) m |= IN.R;
            if (localKeyState.has("KeyW")) m |= IN.J;
            if (localKeyState.has("KeyJ")) m |= IN.P;
            if (localKeyState.has("KeyK")) m |= IN.K;
            if (localKeyState.has("KeyL")) m |= IN.S; // special
            if (localKeyState.has("KeyS")) m |= IN.B; // block
            return m | 0;
        }

        function lockstepCanAdvance(f) {
            return localInputs.has(f) && remoteInputs.has(f);
        }

        function getInputsForFrame(f) {
            const li = localInputs.get(f) | 0;
            const ri = remoteInputs.get(f) | 0;

            // Map to [p1Mask,p2Mask] based on local player index
            if (localPlayerIndex === 0) return [li, ri];
            return [ri, li];
        }

        function tickOneFrame() {
            // Schedule/send our input for (frame + delay)
            const sendFrame = frame + inputDelay;
            if (!localInputs.has(sendFrame)) {
                const mask = buildLocalInputMask();
                localInputs.set(sendFrame, mask);
                // Send to remote as soon as we have it
                Net.send({ t: "in", f: sendFrame, m: mask });
            }

            // Ensure remote also gets our "frame 0..delay-1" eventually
            // (they will stall until both have those frames)

            if (!lockstepCanAdvance(frame)) {
                stalled = true;
                stallFrames++;

                // Ask peer to resend inputs if we've been waiting ~1 second.
                if (stallFrames % 60 === 0) {
                    Net.send({ t: "req", f: frame });
                }

                return;
            }

            stalled = false;
            stallFrames = 0;

            const masks = getInputsForFrame(frame);
            stepLogic(masks);

            frame++;
        }

        function render() {
            if (!ctx) return;

            // camera shake
            let sx = 0, sy = 0;
            if (shake > 0) {
                const amt = shake * 0.8;
                sx = Math.floor((rand01() * 2 - 1) * amt);
                sy = Math.floor((rand01() * 2 - 1) * amt);
                shake--;
            }

            ctx.save();
            ctx.clearRect(0, 0, ARENA_W, ARENA_H);
            ctx.translate(sx, sy);

            // Background
            const grd = ctx.createLinearGradient(0, 0, 0, ARENA_H);
            grd.addColorStop(0, "#0a1634");
            grd.addColorStop(1, "#070a10");
            ctx.fillStyle = grd;
            ctx.fillRect(0, 0, ARENA_W, ARENA_H);

            // Neon horizon
            ctx.globalAlpha = 0.35;
            ctx.fillStyle = "#66e3ff";
            ctx.fillRect(0, GROUND_Y - 110, ARENA_W, 2);
            ctx.globalAlpha = 1;

            // Ground
            ctx.fillStyle = "rgba(255,255,255,0.04)";
            ctx.fillRect(0, GROUND_Y, ARENA_W, ARENA_H - GROUND_Y);

            // Grid lines
            ctx.strokeStyle = "rgba(255,255,255,0.05)";
            ctx.lineWidth = 1;
            for (let x = 0; x < ARENA_W; x += 80) {
                ctx.beginPath();
                ctx.moveTo(x, GROUND_Y);
                ctx.lineTo(x, ARENA_H);
                ctx.stroke();
            }

            // Projectiles (shape-based)
            for (const p of projectiles) {
                const x = p.x / FP;
                const y = p.y / FP;
                const r = (p.w / FP) / 2;

                ctx.globalAlpha = 0.95;
                ctx.fillStyle = p.color || "#66e3ff";
                ctx.strokeStyle = "rgba(255,255,255,0.25)";
                ctx.lineWidth = 2;

                const shape = p.shape || "orb";
                if (shape === "banana") {
                    // Banana: curved capsule
                    ctx.beginPath();
                    ctx.ellipse(x, y, r * 1.2, r * 0.7, 0.6, 0, Math.PI * 2);
                    ctx.fill();
                    ctx.stroke();
                } else if (shape === "shuriken") {
                    // Shuriken: 4-point star
                    ctx.beginPath();
                    for (let i = 0; i < 4; i++) {
                        const ang = (Math.PI / 2) * i + (p.ownerIdx ? 0.2 : -0.2);
                        const ox = Math.cos(ang) * r * 1.1;
                        const oy = Math.sin(ang) * r * 1.1;
                        ctx.lineTo(x + ox, y + oy);
                        ctx.lineTo(x + ox * 0.25, y + oy * 0.25);
                    }
                    ctx.closePath();
                    ctx.fill();
                    ctx.stroke();
                } else if (shape === "kunai") {
                    // Kunai: triangle + ring
                    ctx.beginPath();
                    ctx.moveTo(x + r, y);
                    ctx.lineTo(x - r * 0.8, y - r * 0.6);
                    ctx.lineTo(x - r * 0.8, y + r * 0.6);
                    ctx.closePath();
                    ctx.fill();
                    ctx.stroke();

                    ctx.beginPath();
                    ctx.arc(x - r * 0.95, y, r * 0.25, 0, Math.PI * 2);
                    ctx.stroke();
                } else {
                    // Orb default
                    ctx.beginPath();
                    ctx.arc(x, y, r, 0, Math.PI * 2);
                    ctx.fill();
                    ctx.stroke();
                }

                ctx.globalAlpha = 1;
            }

            // Fighters
            for (const f of fighters) {
                drawFighter(f);
            }

            // Particles
            for (const pt of particles) {
                ctx.fillStyle = pt.color;
                ctx.globalAlpha = clamp(pt.life / 26, 0, 1);
                ctx.fillRect(pt.x / FP, pt.y / FP, 3, 3);
            }
            ctx.globalAlpha = 1;

            // Debug sync overlay
            if (stalled) {
                ctx.fillStyle = "rgba(0,0,0,0.40)";
                ctx.fillRect(0, 0, ARENA_W, ARENA_H);
                ctx.fillStyle = "#ffffff";
                ctx.font = "800 18px system-ui";
                ctx.textAlign = "center";
                ctx.fillText("SYNCING...", ARENA_W / 2, ARENA_H / 2);
                ctx.font = "12px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace";
                ctx.fillStyle = "rgba(255,255,255,0.75)";
                ctx.fillText(`waiting for inputs (frame ${frame})`, ARENA_W / 2, ARENA_H / 2 + 22);
            }

            ctx.restore();

            // HUD updates
            UI.setHP(0, fighters[0].hp / fighters[0].d.maxHP);
            UI.setHP(1, fighters[1].hp / fighters[1].d.maxHP);
            UI.setMeter(0, fighters[0].meter / 100);
            UI.setMeter(1, fighters[1].meter / 100);

            UI.setSyncText(stalled ? `syncing… (${stallFrames}f)` : "");
        }

        function drawFighter(f) {
            const x = f.x / FP;
            const y = f.y / FP;

            const primary = f.char.palette.primary;
            const secondary = f.char.palette.secondary;

            const w = f.w / FP;
            const h = f.h / FP;

            const viz = f.viz || { silhouette: "balanced", head: "none", face: "none", pattern: "plain", aura: "none" };

            // Animation bob
            const bob =
                (f.state === "run") ? Math.sin((f.stateFrame / 2) * 0.7) * 3 :
                    (f.state === "idle") ? Math.sin((f.stateFrame / 10) * 0.7) * 1.6 :
                        0;

            // Shadow
            ctx.fillStyle = "rgba(0,0,0,0.30)";
            ctx.beginPath();
            ctx.ellipse(x, GROUND_Y + 8, 26 + (viz.silhouette === "bulky" ? 6 : 0), 10, 0, 0, Math.PI * 2);
            ctx.fill();

            // Aura (high special looks more alive)
            if (viz.aura && viz.aura !== "none") {
                const auraCol =
                    viz.aura === "electric" ? "rgba(102,227,255,0.18)" :
                        viz.aura === "void" ? "rgba(201,167,255,0.18)" :
                            viz.aura === "wind" ? "rgba(122,240,209,0.16)" :
                                "rgba(255,206,90,0.16)";

                ctx.globalAlpha = 1;
                ctx.fillStyle = auraCol;
                ctx.beginPath();
                ctx.ellipse(x, y - h * 0.6 + bob, w * 0.75, h * 0.60, 0, 0, Math.PI * 2);
                ctx.fill();
            }

            // Body
            ctx.fillStyle = primary;
            roundRect(ctx, x - w / 2, y - h + bob, w, h, 14);
            ctx.fill();

            // Pattern
            ctx.globalAlpha = 0.16;
            ctx.fillStyle = secondary;
            if (viz.pattern === "stripe") {
                for (let i = 0; i < 4; i++) {
                    const px = x - w / 2 + 6 + i * (w / 4);
                    roundRect(ctx, px, y - h + 14 + bob, 6, h - 28, 6);
                    ctx.fill();
                }
            } else if (viz.pattern === "chevron") {
                ctx.beginPath();
                ctx.moveTo(x - w * 0.35, y - h * 0.55 + bob);
                ctx.lineTo(x, y - h * 0.35 + bob);
                ctx.lineTo(x + w * 0.35, y - h * 0.55 + bob);
                ctx.lineTo(x + w * 0.28, y - h * 0.65 + bob);
                ctx.lineTo(x, y - h * 0.47 + bob);
                ctx.lineTo(x - w * 0.28, y - h * 0.65 + bob);
                ctx.closePath();
                ctx.fill();
            } else if (viz.pattern === "dot") {
                for (let yy = 0; yy < 5; yy++) {
                    for (let xx = 0; xx < 3; xx++) {
                        ctx.beginPath();
                        ctx.arc(x - w * 0.25 + xx * w * 0.25, y - h * 0.75 + yy * h * 0.16 + bob, 3, 0, Math.PI * 2);
                        ctx.fill();
                    }
                }
            }
            ctx.globalAlpha = 1;

            // Head (simple cap area)
            const headY = y - h + 18 + bob;
            ctx.fillStyle = "rgba(255,255,255,0.10)";
            roundRect(ctx, x - w * 0.35, headY, w * 0.70, 18, 10);
            ctx.fill();

            // Headgear
            ctx.fillStyle = secondary;
            if (viz.head === "bandana") {
                roundRect(ctx, x - w * 0.40, headY + 6, w * 0.80, 10, 8);
                ctx.fill();
            } else if (viz.head === "hood") {
                ctx.globalAlpha = 0.35;
                roundRect(ctx, x - w * 0.45, headY - 6, w * 0.90, 28, 14);
                ctx.fill();
                ctx.globalAlpha = 1;
            } else if (viz.head === "helmet") {
                ctx.globalAlpha = 0.50;
                roundRect(ctx, x - w * 0.45, headY - 8, w * 0.90, 30, 14);
                ctx.fill();
                ctx.globalAlpha = 1;
            } else if (viz.head === "topknot") {
                ctx.beginPath();
                ctx.arc(x, headY - 6, 8, 0, Math.PI * 2);
                ctx.fill();
            }

            // Face
            if (viz.face === "mask") {
                ctx.globalAlpha = 0.30;
                ctx.fillStyle = secondary;
                roundRect(ctx, x - w * 0.26, headY + 10, w * 0.52, 12, 8);
                ctx.fill();
                ctx.globalAlpha = 1;
            } else if (viz.face === "visor") {
                ctx.globalAlpha = 0.22;
                ctx.fillStyle = "#ffffff";
                roundRect(ctx, x - w * 0.28, headY + 10, w * 0.56, 12, 8);
                ctx.fill();
                ctx.globalAlpha = 1;
            }

            // Arms (attack reach)
            const dir = f.facing;
            const armY = y - 72 + bob;
            const armLen =
                (f.state === "punch" && f.stateFrame >= 4 && f.stateFrame <= 7) ? 42 :
                    (f.state === "kick" && f.stateFrame >= 6 && f.stateFrame <= 9) ? 30 :
                        26;

            ctx.strokeStyle = secondary;
            ctx.lineWidth = 6;
            ctx.lineCap = "round";
            ctx.beginPath();
            ctx.moveTo(x, armY);
            ctx.lineTo(x + dir * armLen, armY + (f.state === "punch" ? -4 : 0));
            ctx.stroke();

            // Leg hint (kick)
            const legY = y - 18;
            const legLen = (f.state === "kick" && f.stateFrame >= 5 && f.stateFrame <= 10) ? 44 : 26;
            ctx.strokeStyle = "rgba(255,255,255,0.18)";
            ctx.lineWidth = 7;
            ctx.beginPath();
            ctx.moveTo(x, legY);
            ctx.lineTo(x + dir * legLen, legY + 10);
            ctx.stroke();

            // Block shield
            if (f.state === "block") {
                ctx.globalAlpha = 0.25;
                ctx.fillStyle = secondary;
                ctx.beginPath();
                ctx.arc(x + dir * (w * 0.65), y - 70, 22, 0, Math.PI * 2);
                ctx.fill();
                ctx.globalAlpha = 1;
            }

            // KO tint
            if (f.state === "ko") {
                ctx.globalAlpha = 0.6;
                ctx.fillStyle = "#000";
                ctx.fillRect(x - w / 2, y - h, w, h);
                ctx.globalAlpha = 1;
            }
        }

        function roundRect(ctx, x, y, w, h, r) {
            r = Math.min(r, w / 2, h / 2);
            ctx.beginPath();
            ctx.moveTo(x + r, y);
            ctx.arcTo(x + w, y, x + w, y + h, r);
            ctx.arcTo(x + w, y + h, x, y + h, r);
            ctx.arcTo(x, y + h, x, y, r);
            ctx.arcTo(x, y, x + w, y, r);
            ctx.closePath();
        }

        function gameLoop(t) {
            if (!running) return;
            const dt = t - lastTime;
            lastTime = t;
            acc += dt;

            // Cap catch-up to avoid spiral
            acc = Math.min(acc, 200);

            while (acc >= FRAME_MS) {
                tickOneFrame();
                acc -= FRAME_MS;
            }

            render();
            requestAnimationFrame(gameLoop);
        }

        function start(canvasEl) {
            canvas = canvasEl;
            ctx = canvas.getContext("2d", { alpha: false });

            running = true;
            lastTime = now();
            acc = 0;
            requestAnimationFrame(gameLoop);
        }

        function stop() {
            running = false;
        }

        // Remote input injection
        function pushRemoteInput(f, mask) {
            // store remote by simulation frame
            if (!remoteInputs.has(f)) remoteInputs.set(f, mask | 0);
        }
        function resendLocalInputs(from, count = 180) {
            // Resend already-known local inputs for a window of frames.
            // Helps recovery if the peer is missing some frames for any reason.
            for (let f = from; f < from + count; f++) {
                if (localInputs.has(f)) {
                    Net.send({ t: "in", f, m: localInputs.get(f) | 0 });
                }
            }
        }

        function hashStr32(s) {
            // Deterministic 32-bit hash (FNV-1a-ish)
            s = String(s || "");
            let h = 2166136261 | 0;
            for (let i = 0; i < s.length; i++) {
                h ^= s.charCodeAt(i);
                h = Math.imul(h, 16777619);
            }
            return h | 0;
        }

        function pick(arr, h, salt) {
            const idx = Math.abs((h ^ (salt | 0)) | 0) % arr.length;
            return arr[idx];
        }

        function deriveVisuals(char) {
            const h = hashStr32(char.name + "|" + char.tagline);

            // Silhouette from stats (so it "feels" tied to build)
            const bulkyScore = (char.stats.health + char.stats.defense) - char.stats.speed;
            const nimbleScore = char.stats.speed + char.stats.jump - char.stats.health;

            const silhouette =
                bulkyScore >= 6 ? "bulky" :
                    nimbleScore >= 6 ? "nimble" :
                        "balanced";

            const head = pick(["none", "bandana", "hood", "helmet", "topknot"], h, 11);
            const face = pick(["none", "mask", "visor"], h, 23);
            const pattern = pick(["plain", "stripe", "chevron", "dot"], h, 37);
            const aura = (char.stats.special >= 7) ? pick(["none", "electric", "void", "wind", "fire"], h, 51) : "none";

            const projShape = pick(["orb", "shuriken", "kunai", "banana"], h, 71);

            return { h, silhouette, head, face, pattern, aura, projShape };
        }

        function pushLocalInput(f, mask) {
            if (!localInputs.has(f)) localInputs.set(f, mask | 0);
        }

        // Key handling
        function setKey(code, down) {
            if (down) localKeyState.add(code);
            else localKeyState.delete(code);
        }

        return {
            resetMatch,
            start,
            stop,
            pushRemoteInput,
            pushLocalInput,
            resendLocalInputs,
            setKey,
            get frame() { return frame; }
        };
    })();

    // -----------------------------
    // UI / Router
    // -----------------------------
    const UI = (() => {
        const screens = [
            "#screen-username",
            "#screen-home",
            "#screen-prompt",
            "#screen-import",
            "#screen-lobby",
            "#screen-game",
            "#screen-result"
        ];

        function show(id) {
            for (const s of screens) $(s).classList.remove("active");
            $(id).classList.add("active");
        }

        function setUserLabel(name) {
            $("#userLabel").textContent = name || "—";
        }

        function toastOk(el, msg) {
            el.style.display = "block";
            el.textContent = msg;
            setTimeout(() => { el.style.display = "none"; }, 2600);
        }

        function toastErr(el, msg) {
            el.style.display = "block";
            el.textContent = msg;
        }

        function clearToasts() {
            $("#importError").style.display = "none";
            $("#importOk").style.display = "none";
        }

        function updateSettingsLabels() {
            $("#volLabel").textContent = `Volume: ${Math.round(settings.volume * 100)}%`;
            $("#delayLabel").textContent = `Input delay: ${settings.inputDelayFrames} frame(s)`;
        }

        function openSettings(open) {
            const modal = $("#settingsModal");
            if (open) {
                modal.classList.add("open");
                modal.setAttribute("aria-hidden", "false");
            } else {
                modal.classList.remove("open");
                modal.setAttribute("aria-hidden", "true");
            }
        }

        // HUD setters
        function setHP(idx, pct) {
            if (idx === 0) {
                $("#p1HP").style.transform = `scaleX(${clamp(pct, 0, 1)})`;
            } else {
                // enemy bar scales from right (we used float:right)
                $("#p2HP").style.transform = `scaleX(${clamp(pct, 0, 1)})`;
            }
        }
        function setMeter(idx, pct) {
            if (idx === 0) $("#p1Meter").style.width = fmtPct(pct);
            else $("#p2Meter").style.width = fmtPct(pct);
        }

        function setHUDNames(p1User, p2User, p1Char, p2Char) {
            $("#p1Name").textContent = p1User;
            $("#p2Name").textContent = p2User;
            $("#p1Char").textContent = p1Char;
            $("#p2Char").textContent = p2Char;
        }

        function setRoundText(t) {
            $("#roundText").textContent = t || "";
        }
        function setSyncText(t) {
            $("#syncText").textContent = t || "";
        }

        function showResult({ title, sub }) {
            $("#resultTitle").textContent = title;
            $("#resultSub").textContent = sub || "";
            show("#screen-result");
        }

        return {
            show,
            setUserLabel,
            toastOk,
            toastErr,
            clearToasts,
            updateSettingsLabels,
            openSettings,
            setHP,
            setMeter,
            setHUDNames,
            setRoundText,
            setSyncText,
            showResult
        };
    })();

    // -----------------------------
    // App State + Defaults
    // -----------------------------
    function ensureDefaultCharacters() {
        const chars = listCharacters();
        if (chars.length) return;

        const mk = (name, tagline, primary, secondary, stats, specialName, ps, psz) => ({
            version: 1,
            id: makeCharId(),
            name,
            tagline,
            palette: { primary, secondary },
            stats,
            moves: { specialName, projectileSpeed: ps, projectileSize: psz },
            meta: { createdAt: new Date().toISOString(), authorHint: "default" }
        });

        const c1 = mk(
            "Patch",
            "Hotfix delivered.",
            "#66e3ff",
            "#a5ff7a",
            { health: 5, attack: 5, defense: 5, speed: 5, jump: 5, special: 5, range: 4 }, // sum 34
            "Diff Blast",
            12, 14
        );

        const c2 = mk(
            "Null",
            "Your effort returns void.",
            "#ff5a7a",
            "#ffce5a",
            { health: 6, attack: 6, defense: 6, speed: 4, jump: 4, special: 4, range: 4 }, // sum 34
            "Void Orb",
            10, 16
        );

        saveCharacters([c1, c2]);
        setActiveCharId(c1.id);
    }

    function getActiveCharacter() {
        const chars = listCharacters();
        const id = getActiveCharId();
        return chars.find(c => c.id === id) || chars[0] || null;
    }

    function refreshCharUI() {
        const chars = listCharacters();
        const select = $("#charSelect");
        select.innerHTML = "";

        if (!chars.length) {
            const opt = document.createElement("option");
            opt.value = "";
            opt.textContent = "(none)";
            select.appendChild(opt);
            $("#charSummary").textContent = "No characters saved.";
            return;
        }

        for (const c of chars) {
            const opt = document.createElement("option");
            opt.value = c.id;
            opt.textContent = `${c.name}`;
            select.appendChild(opt);
        }

        const activeId = getActiveCharId() || chars[0].id;
        select.value = activeId;
        const active = chars.find(c => c.id === select.value) || chars[0];

        $("#charSummary").textContent = characterSummaryText(active);
    }

    function updateActiveCharLabel() {
        const c = getActiveCharacter();
        $("#activeCharLabel").textContent = c ? c.name : "—";
    }

    // -----------------------------
    // Multiplayer Match Orchestration
    // -----------------------------
    let remoteHello = null; // { user, char }
    let localHello = null;  // { user, char }
    let matchSeed = 0;

    function setNetStatus(s) {
        $("#netStatus").textContent = `Status: ${s}`;
    }

    function updateStartMatchEnabled() {
        const ok = Net.ready() && localHello && remoteHello;
        $("#btnStartMatch").disabled = !ok;
    }

    function sendHello() {
        const uname = Storage.get(KEYS.username, "Player");
        const c = getActiveCharacter();
        if (!c) return;

        localHello = { user: uname, char: c };
        Net.send({ t: "hello", user: uname, char: c });
        updateStartMatchEnabled();
    }

    function resetLobbyNetState() {
        remoteHello = null;
        localHello = null;
        matchSeed = 0;
        updateStartMatchEnabled();
    }

    function startMatchAsHost() {
        if (!localHello || !remoteHello) return;

        // deterministic seed derived from time but clamped to int32
        matchSeed = (Date.now() & 0x7fffffff) | 0;
        const payload = {
            t: "start",
            seed: matchSeed,
            p1User: localHello.user,
            p2User: remoteHello.user,
            p1Char: localHello.char,
            p2Char: remoteHello.char
        };
        Net.send(payload);

        // Host is P1 (localIndex 0)
        UI.show("#screen-game");
        Audio.resumeIfSuspended();
        Audio.startMusic();

        Game.resetMatch({
            seedIn: matchSeed,
            localIndex: 0,
            p1Char: localHello.char,
            p2Char: remoteHello.char,
            p1Name: localHello.user,
            p2Name: remoteHello.user
        });
        Game.start($("#gameCanvas"));
    }

    function startMatchAsJoiner(msg) {
        // Joiner is P2 (localIndex 1)
        UI.show("#screen-game");
        Audio.resumeIfSuspended();
        Audio.startMusic();

        Game.resetMatch({
            seedIn: msg.seed | 0,
            localIndex: 1,
            p1Char: msg.p1Char,
            p2Char: msg.p2Char,
            p1Name: msg.p1User,
            p2Name: msg.p2User
        });
        Game.start($("#gameCanvas"));
    }

    // -----------------------------
    // Wire UI events
    // -----------------------------
    function wireUI() {
        // Global nav
        $("#btnHome").addEventListener("click", () => { Audio.sfx.ui(); UI.show("#screen-home"); });
        $("#btnSettings").addEventListener("click", () => { Audio.sfx.ui(); UI.openSettings(true); });
        $("#btnCloseSettings").addEventListener("click", () => { Audio.sfx.ui(); UI.openSettings(false); });

        // Settings controls
        $("#volRange").value = String(Math.round(settings.volume * 100));
        $("#musicToggle").checked = !!settings.music;
        $("#sfxToggle").checked = !!settings.sfx;
        $("#delayRange").value = String(settings.inputDelayFrames);
        UI.updateSettingsLabels();

        $("#volRange").addEventListener("input", (e) => {
            settings.volume = Number(e.target.value) / 100;
            saveSettings();
        });
        $("#musicToggle").addEventListener("change", (e) => {
            settings.music = !!e.target.checked;
            saveSettings();
            if (settings.music) Audio.startMusic(); else Audio.stopMusic();
        });
        $("#sfxToggle").addEventListener("change", (e) => {
            settings.sfx = !!e.target.checked;
            saveSettings();
        });
        $("#delayRange").addEventListener("input", (e) => {
            settings.inputDelayFrames = Number(e.target.value) | 0;
            saveSettings();
        });

        $("#btnResetStorage").addEventListener("click", () => {
            if (!confirm("Reset all local storage (username, characters, settings)?")) return;
            localStorage.clear();
            location.reload();
        });

        // Username flow
        $("#btnUsernameContinue").addEventListener("click", () => {
            Audio.resumeIfSuspended();
            Audio.sfx.ui();
            const u = $("#usernameInput").value.trim();
            if (!u) return;
            Storage.set(KEYS.username, u);
            UI.setUserLabel(u);
            UI.show("#screen-home");
        });

        // Home navigation
        $("#btnGoPrompt").addEventListener("click", () => { Audio.sfx.ui(); UI.show("#screen-prompt"); });
        $("#btnGoImport").addEventListener("click", () => { Audio.sfx.ui(); refreshCharUI(); UI.show("#screen-import"); });
        $("#btnGoLobby").addEventListener("click", () => { Audio.sfx.ui(); updateActiveCharLabel(); UI.show("#screen-lobby"); });

        // Prompt generator
        $("#btnGeneratePrompt").addEventListener("click", () => {
            Audio.sfx.ui();
            const archetype = $("#archSelect").value;
            const theme = $("#themeInput").value.trim();
            const line = $("#lineInput").value.trim();
            $("#promptOut").value = buildPrompt({ archetype, theme, line });
        });
        $("#btnCopyPrompt").addEventListener("click", async () => {
            Audio.sfx.ui();
            const t = $("#promptOut").value;
            if (!t.trim()) return;
            await copyToClipboard(t);
        });

        // Character manage
        $("#charSelect").addEventListener("change", () => {
            const chars = listCharacters();
            const c = chars.find(x => x.id === $("#charSelect").value);
            if (!c) return;
            $("#charSummary").textContent = characterSummaryText(c);
        });

        $("#btnValidateSave").addEventListener("click", async () => {
            Audio.sfx.ui();
            UI.clearToasts();
            const txt = $("#charCodeIn").value.trim();
            if (!txt) return UI.toastErr($("#importError"), "Paste JSON first.");

            const parsed = safeJsonParse(txt);
            if (!parsed.ok) return UI.toastErr($("#importError"), `JSON parse error: ${parsed.error}`);

            const v = validateAndNormalizeCharacter(parsed.value);
            if (!v.ok) return UI.toastErr($("#importError"), v.errors.join("\n"));

            // Assign id if missing
            const c = v.character;
            if (!c.id) c.id = makeCharId();

            const chars = listCharacters();
            const idx = chars.findIndex(x => x.id === c.id);
            if (idx >= 0) chars[idx] = c;
            else chars.push(c);

            saveCharacters(chars);

            // Set active on save
            setActiveCharId(c.id);

            refreshCharUI();
            updateActiveCharLabel();
            UI.toastOk($("#importOk"), `Saved "${c.name}" (budget sum ${v.budgetSum}/${CharacterSpec.budget}).`);
        });

        $("#btnClearCode").addEventListener("click", () => {
            Audio.sfx.ui();
            $("#charCodeIn").value = "";
            UI.clearToasts();
        });

        $("#btnUseThisChar").addEventListener("click", () => {
            Audio.sfx.ui();
            const id = $("#charSelect").value;
            if (!id) return;
            setActiveCharId(id);
            updateActiveCharLabel();
            UI.toastOk($("#importOk"), "Active character set.");
        });

        $("#btnDeleteChar").addEventListener("click", () => {
            Audio.sfx.ui();
            const id = $("#charSelect").value;
            if (!id) return;
            if (!confirm("Delete this character?")) return;
            const chars = listCharacters().filter(c => c.id !== id);
            saveCharacters(chars);
            if (getActiveCharId() === id) setActiveCharId(chars[0]?.id || null);
            refreshCharUI();
            updateActiveCharLabel();
        });

        $("#btnExportChar").addEventListener("click", async () => {
            Audio.sfx.ui();
            const id = $("#charSelect").value;
            const c = listCharacters().find(x => x.id === id);
            if (!c) return;
            await copyToClipboard(JSON.stringify(c, null, 2));
            UI.toastOk($("#importOk"), "Copied selected character JSON to clipboard.");
        });

        // Lobby: Host/Join flows
        $("#btnHostCreateOffer").addEventListener("click", async () => {
            Audio.resumeIfSuspended();
            Audio.sfx.ui();
            resetLobbyNetState();
            try {
                const offer = await Net.createOfferCode();
                $("#offerOut").value = offer;
                $("#answerIn").value = "";
            } catch (e) {
                alert(String(e?.message || e));
            }
        });

        $("#btnHostAcceptAnswer").addEventListener("click", async () => {
            Audio.resumeIfSuspended();
            Audio.sfx.ui();
            try {
                await Net.acceptAnswerCode($("#answerIn").value.trim());
            } catch (e) {
                alert(String(e?.message || e));
            }
        });

        $("#btnHostReset").addEventListener("click", () => {
            Audio.sfx.ui();
            $("#offerOut").value = "";
            $("#answerIn").value = "";
            Net.reset();
            resetLobbyNetState();
            updateStartMatchEnabled();
        });

        $("#btnJoinCreateAnswer").addEventListener("click", async () => {
            Audio.resumeIfSuspended();
            Audio.sfx.ui();
            resetLobbyNetState();
            try {
                const ans = await Net.createAnswerCode($("#offerIn").value.trim());
                $("#answerOut").value = ans;
            } catch (e) {
                alert(String(e?.message || e));
            }
        });

        $("#btnJoinReset").addEventListener("click", () => {
            Audio.sfx.ui();
            $("#offerIn").value = "";
            $("#answerOut").value = "";
            Net.reset();
            resetLobbyNetState();
            updateStartMatchEnabled();
        });

        $("#btnDisconnect").addEventListener("click", () => {
            Audio.sfx.ui();
            Net.reset();
            resetLobbyNetState();
            updateStartMatchEnabled();
        });

        $("#btnStartMatch").addEventListener("click", () => {
            Audio.sfx.ui();
            if (!Net.isHost()) {
                alert("Only the Host starts the match (for a single deterministic seed).");
                return;
            }
            startMatchAsHost();
        });

        // Match controls
        $("#btnLeaveMatch").addEventListener("click", () => {
            Audio.sfx.ui();
            Game.stop();
            Audio.stopMusic();
            UI.show("#screen-lobby");
        });

        // Result screen buttons
        $("#btnRematch").addEventListener("click", () => {
            Audio.sfx.ui();
            // Host can rematch by starting again; joiner waits for host's start.
            UI.show("#screen-lobby");
            UI.setRoundText("");
        });

        $("#btnBackToLobby").addEventListener("click", () => {
            Audio.sfx.ui();
            UI.show("#screen-lobby");
        });

        // Keyboard input (gameplay)
        window.addEventListener("keydown", (e) => {
            // Prevent scrolling / default shortcuts during gameplay
            const inGame = $("#screen-game").classList.contains("active");
            if (inGame && ["KeyW", "KeyA", "KeyS", "KeyD", "KeyJ", "KeyK", "KeyL", "Space"].includes(e.code)) {
                e.preventDefault();
            }

            // Ensure audio can start on first user gesture
            Audio.resumeIfSuspended();

            // Only feed game keys while in game screen
            if (inGame) {
                Game.setKey(e.code, true);
            }
        });

        window.addEventListener("keyup", (e) => {
            const inGame = $("#screen-game").classList.contains("active");
            if (inGame) Game.setKey(e.code, false);
        });

        // Click anywhere to unlock audio (helps on some platforms)
        window.addEventListener("pointerdown", () => {
            Audio.resumeIfSuspended();
        }, { passive: true });
    }

    // -----------------------------
    // Net message handling
    // -----------------------------
    function wireNet() {
        Net.setHandlers({
            onStatus: (s) => {
                setNetStatus(s);
            },
            onOpen: () => {
                setNetStatus("connected");
                // Immediately exchange hellos
                sendHello();
            },
            onClose: () => {
                setNetStatus("disconnected");
                $("#btnStartMatch").disabled = true;
            },
            onMessage: (msg) => {
                if (!msg || typeof msg !== "object") return;

                if (msg.t === "hello") {
                    // Validate character from remote to ensure fairness locally too
                    const v = validateAndNormalizeCharacter(msg.char);
                    if (!v.ok) {
                        // If remote is cheating, we can just refuse to start
                        setNetStatus("remote sent invalid character");
                        return;
                    }
                    remoteHello = { user: String(msg.user || "Remote"), char: v.character };
                    updateStartMatchEnabled();
                    return;
                }

                if (msg.t === "start") {
                    // Joiner receives start payload from host
                    // Validate everything
                    const v1 = validateAndNormalizeCharacter(msg.p1Char);
                    const v2 = validateAndNormalizeCharacter(msg.p2Char);
                    if (!v1.ok || !v2.ok) return;

                    startMatchAsJoiner({
                        seed: msg.seed | 0,
                        p1User: String(msg.p1User || "P1"),
                        p2User: String(msg.p2User || "P2"),
                        p1Char: v1.character,
                        p2Char: v2.character
                    });
                    return;
                }

                if (msg.t === "req") {
                    // Peer requests resend starting from frame msg.f
                    const from = msg.f | 0;
                    Game.resendLocalInputs(from, 180);
                    return;
                }

                if (msg.t === "in") {
                    // Remote input for a given frame
                    const f = msg.f | 0;
                    const m = msg.m | 0;
                    Game.pushRemoteInput(f, m);
                    return;
                }
            }
        });
    }

    // -----------------------------
    // Boot
    // -----------------------------
    function boot() {
        ensureDefaultCharacters();

        // Restore username
        const u = Storage.get(KEYS.username, "");
        if (u) {
            UI.setUserLabel(u);
            $("#usernameInput").value = u;
            UI.show("#screen-home");
        } else {
            UI.show("#screen-username");
        }

        // Active char label in lobby
        updateActiveCharLabel();

        // Start music if enabled (will only actually play after user gesture)
        Audio.setMaster(settings.volume);
        Audio.setEnabled(settings.music, settings.sfx);
        if (settings.music) Audio.startMusic();

        wireUI();
        wireNet();

        // Populate import UI if visited
        refreshCharUI();
    }

    boot();
})();

import './index.css';

