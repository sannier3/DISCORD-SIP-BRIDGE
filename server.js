import 'dotenv/config';

import fs from 'node:fs';
import process from 'node:process';
import { EventEmitter } from 'node:events';
import { PassThrough, Transform } from 'node:stream';
import { randomUUID } from 'node:crypto';

import WebSocket from 'ws';
import prism from 'prism-media';
import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ChannelType,
    Client,
    EmbedBuilder,
    Events,
    GatewayIntentBits,
    PermissionFlagsBits,
    SlashCommandBuilder,
} from 'discord.js';
import {
    AudioPlayerStatus,
    EndBehaviorType,
    NoSubscriberBehavior,
    StreamType,
    VoiceConnectionStatus,
    createAudioPlayer,
    createAudioResource,
    entersState,
    generateDependencyReport,
    joinVoiceChannel,
} from '@discordjs/voice';

const CREDENTIALS_FILE = process.env.ASTERISK_CREDENTIALS_FILE?.trim()
    || '/root/discord-asterisk-credentials.txt';
const MEDIA_SUBPROTOCOL = 'media';
const DEFAULT_MEDIA_FRAME_SIZE = 640; // slin16, 16 kHz, mono, 20 ms
const MAX_MEDIA_WS_BUFFER = 256 * 1024;
const MAX_DISCORD_PCM_BUFFER = 3840 * 50;

function loadAsteriskCredentialsFile() {
    if (!fs.existsSync(CREDENTIALS_FILE)) {
        return;
    }

    try {
        const values = Object.fromEntries(
            fs.readFileSync(CREDENTIALS_FILE, 'utf8')
                .split(/\r?\n/u)
                .map((line) => line.trim())
                .filter((line) => line && !line.startsWith('#') && line.includes('='))
                .map((line) => {
                    const separator = line.indexOf('=');
                    return [line.slice(0, separator), line.slice(separator + 1)];
                }),
        );

        process.env.ARI_BASE_URL ??= values.ARI_URL;
        process.env.ARI_USERNAME ??= values.ARI_USERNAME;
        process.env.ARI_PASSWORD ??= values.ARI_PASSWORD;
        process.env.ARI_APPLICATION ??= values.ARI_APPLICATION;
        process.env.PJSIP_ENDPOINT ??= values.PJSIP_ENDPOINT;
    } catch (error) {
        console.warn(`[CONFIG] Lecture impossible de ${CREDENTIALS_FILE}: ${error.message}`);
    }
}

loadAsteriskCredentialsFile();

function requiredEnvironment(name) {
    const value = process.env[name]?.trim();
    if (!value) {
        throw new Error(`Variable d'environnement obligatoire absente: ${name}`);
    }
    return value;
}

function integerEnvironment(name, defaultValue, minimum = 0) {
    const raw = process.env[name]?.trim();
    if (!raw) {
        return defaultValue;
    }

    const value = Number.parseInt(raw, 10);
    if (!Number.isInteger(value) || value < minimum) {
        throw new Error(`${name} doit être un entier supérieur ou égal à ${minimum}`);
    }
    return value;
}

function csvEnvironment(name) {
    return new Set(
        (process.env[name] ?? '')
            .split(',')
            .map((value) => value.trim())
            .filter(Boolean),
    );
}

function booleanEnvironment(name, defaultValue) {
    const raw = process.env[name]?.trim().toLowerCase();
    if (!raw) {
        return defaultValue;
    }
    return ['1', 'true', 'yes', 'oui', 'on'].includes(raw);
}

function yeastarPatternToRegExp(pattern) {
    let source = '^';

    for (const character of pattern) {
        if (character === 'X') {
            source += '[0-9]';
        } else if (character === 'Z') {
            source += '[1-9]';
        } else if (character === '.') {
            source += '[0-9]*';
        } else if (/[0-9]/u.test(character)) {
            source += character;
        } else {
            throw new Error(
                `Modèle Yeastar invalide « ${pattern} » : caractères autorisés 0-9, X, Z et .`,
            );
        }
    }

    source += '$';
    return new RegExp(source, 'u');
}

function parseCommaSeparatedEntries(raw) {
    if (!raw?.trim()) {
        return [];
    }

    return raw.split(',').map((entry) => entry.trim()).filter(Boolean);
}

function parseCalledNumberPatterns(raw) {
    const patterns = parseCommaSeparatedEntries(raw || '0ZXXXXXXXX');
    if (patterns.length === 0) {
        throw new Error('CALLED_NUMBER_PATTERN doit contenir au moins un modèle.');
    }

    return patterns.map((pattern) => ({
        pattern,
        regex: yeastarPatternToRegExp(pattern),
    }));
}

function parseOutboundDialRules(raw) {
    if (!raw?.trim()) {
        return [];
    }

    return parseCommaSeparatedEntries(raw).flatMap((entry, index) => {
        const separator = entry.indexOf(':');
        if (separator <= 0) {
            throw new Error(
                `OUTBOUND_DIAL_RULES entrée ${index + 1} invalide : attendu pattern:prefix`,
            );
        }

        const pattern = entry.slice(0, separator).trim();
        const prefix = entry.slice(separator + 1).trim();
        if (!pattern || !prefix) {
            throw new Error(
                `OUTBOUND_DIAL_RULES entrée ${index + 1} invalide : pattern et prefix obligatoires`,
            );
        }

        return [{
            pattern,
            prefix,
            regex: yeastarPatternToRegExp(pattern),
        }];
    });
}

const config = {
    discordToken: requiredEnvironment('DISCORD_TOKEN'),
    discordGuildId: process.env.DISCORD_GUILD_ID?.trim() || null,
    ariBaseUrl: process.env.ARI_BASE_URL?.trim() || 'http://127.0.0.1:8088',
    ariUsername: requiredEnvironment('ARI_USERNAME'),
    ariPassword: requiredEnvironment('ARI_PASSWORD'),
    ariApplication: process.env.ARI_APPLICATION?.trim() || 'discord-sip',
    pjsipEndpoint: process.env.PJSIP_ENDPOINT?.trim() || 'yeastar',
    callerIdName: process.env.CALLER_ID_NAME?.trim() || 'Discord Bridge',
    callerIdNumber: process.env.CALLER_ID_NUMBER?.trim() || '1000',
    allowedUserIds: csvEnvironment('AUTHORIZED_USER_IDS'),
    allowedRoleIds: csvEnvironment('AUTHORIZED_ROLE_IDS'),
    calledNumberPatterns: parseCalledNumberPatterns(process.env.CALLED_NUMBER_PATTERN),
    callTimeoutSeconds: integerEnvironment('CALL_TIMEOUT_SECONDS', 60, 5),
    maxCallDurationSeconds: integerEnvironment('MAX_CALL_DURATION_SECONDS', 3600, 30),
    maxConcurrentCalls: integerEnvironment('MAX_CONCURRENT_CALLS', 1, 1),
    callsPerHourPerUser: integerEnvironment('CALLS_PER_HOUR_PER_USER', 5, 1),
    registerCommands: booleanEnvironment('REGISTER_COMMANDS', true),
    restrictCommandsToAuthorizedOnly: booleanEnvironment('RESTRICT_COMMANDS_TO_AUTHORIZED_ONLY', false),
    restrictCommandsToVoiceText: booleanEnvironment('RESTRICT_COMMANDS_TO_VOICE_TEXT', false),
    hideCalledNumber: booleanEnvironment('HIDE_CALLED_NUMBER', true),
    calledNumberMaskStart: integerEnvironment('CALLED_NUMBER_MASK_START', 3, 0),
    calledNumberMaskEnd: integerEnvironment('CALLED_NUMBER_MASK_END', 3, 0),
    calledNumberMaskChar: process.env.CALLED_NUMBER_MASK_CHAR?.trim() || '•',
    outboundDialRules: parseOutboundDialRules(process.env.OUTBOUND_DIAL_RULES),
    statusRefreshIntervalSeconds: integerEnvironment('STATUS_REFRESH_INTERVAL_SECONDS', 5, 1),
    voiceConnectionTimeoutSeconds: integerEnvironment('VOICE_CONNECTION_TIMEOUT_SECONDS', 30, 10),
    voiceDebug: booleanEnvironment('VOICE_DEBUG', false),
    audioDebug: booleanEnvironment('AUDIO_DEBUG', false),
    voiceDaveEncryption: booleanEnvironment('VOICE_DAVE_ENCRYPTION', false),
};

function log(level, message, context = undefined) {
    const suffix = context ? ` ${JSON.stringify(context)}` : '';
    console[level](`[${new Date().toISOString()}] ${message}${suffix}`);
}

function sleep(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function formatPhoneNumberForDisplay(number) {
    if (!config.hideCalledNumber) {
        return number;
    }

    const maskStart = Math.min(config.calledNumberMaskStart, number.length);
    const maskEnd = Math.min(config.calledNumberMaskEnd, number.length - maskStart);
    const visibleLength = number.length - maskStart - maskEnd;

    if (visibleLength <= 0) {
        return config.calledNumberMaskChar.repeat(number.length);
    }

    const visiblePart = number.slice(maskStart, maskStart + visibleLength);
    return `${config.calledNumberMaskChar.repeat(maskStart)}${visiblePart}${config.calledNumberMaskChar.repeat(maskEnd)}`;
}

function isAllowedCalledNumber(number) {
    return config.calledNumberPatterns.some(({ regex }) => regex.test(number));
}

function resolveDialNumber(number) {
    for (const rule of config.outboundDialRules) {
        if (rule.regex.test(number)) {
            return `${rule.prefix}${number}`;
        }
    }

    return number;
}

function normalizePhoneNumber(input) {
    let number = input.trim().replace(/[\s().-]/gu, '');

    if (/^\+33[1-9][0-9]{8}$/u.test(number)) {
        number = `0${number.slice(3)}`;
    } else if (/^0033[1-9][0-9]{8}$/u.test(number)) {
        number = `0${number.slice(4)}`;
    }

    if (!isAllowedCalledNumber(number)) {
        const patterns = config.calledNumberPatterns.map(({ pattern }) => pattern).join(', ');
        throw new Error(
            `Numéro refusé : aucun modèle CALLED_NUMBER_PATTERN ne correspond (${patterns}).`,
        );
    }

    return number;
}

function isVoiceChannelTextChat(channel) {
    return Boolean(channel?.isVoiceBased?.());
}

function assertVoiceChannelTextChat(interaction) {
    if (!config.restrictCommandsToVoiceText) {
        return;
    }

    if (!isVoiceChannelTextChat(interaction.channel)) {
        throw new Error(
            'Cette commande n’est utilisable que dans le salon textuel d’un salon vocal.',
        );
    }
}

function formatDuration(totalSeconds) {
    const seconds = Math.max(0, Math.floor(totalSeconds));
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const remainingSeconds = seconds % 60;

    return hours > 0
        ? `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`
        : `${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`;
}

function errorText(error) {
    if (error instanceof AriHttpError) {
        return `ARI ${error.status}: ${error.body || error.message}`;
    }
    return error instanceof Error ? error.message : String(error);
}

class AriHttpError extends Error {
    constructor(status, body, method, url) {
        super(`${method} ${url} a répondu HTTP ${status}`);
        this.name = 'AriHttpError';
        this.status = status;
        this.body = body;
    }
}

class AriClient extends EventEmitter {
    constructor(options) {
        super();
        this.baseUrl = new URL(options.baseUrl);
        this.username = options.username;
        this.password = options.password;
        this.application = options.application;
        this.eventSocket = null;
        this.shouldRun = false;
        this.connected = false;
        this.reconnectTimer = null;
        this.reconnectDelayMs = 1000;
    }

    async request(method, resourcePath, query = {}, body = undefined) {
        const url = new URL(this.baseUrl.toString());
        const basePath = url.pathname.replace(/\/$/u, '');
        url.pathname = `${basePath}/ari/${resourcePath.replace(/^\//u, '')}`;

        for (const [key, value] of Object.entries(query)) {
            if (value !== undefined && value !== null && value !== '') {
                url.searchParams.set(key, String(value));
            }
        }

        const response = await fetch(url, {
            method,
            headers: {
                Authorization: `Basic ${Buffer.from(`${this.username}:${this.password}`).toString('base64')}`,
                ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
            },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: AbortSignal.timeout(15_000),
        });

        const responseText = await response.text();
        if (!response.ok) {
            throw new AriHttpError(response.status, responseText, method, url.toString());
        }

        if (!responseText) {
            return null;
        }

        try {
            return JSON.parse(responseText);
        } catch {
            return responseText;
        }
    }

    createEventSocketUrl() {
        const url = new URL(this.baseUrl.toString());
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        const basePath = url.pathname.replace(/\/$/u, '');
        url.pathname = `${basePath}/ari/events`;
        url.searchParams.set('app', this.application);
        url.searchParams.set('api_key', `${this.username}:${this.password}`);
        url.searchParams.set('subscribeAll', 'false');
        return url;
    }

    createMediaSocketUrl(connectionId) {
        const url = new URL(this.baseUrl.toString());
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        const basePath = url.pathname.replace(/\/$/u, '');
        url.pathname = `${basePath}/media/${encodeURIComponent(connectionId)}`;
        url.search = '';
        return url;
    }

    async start() {
        this.shouldRun = true;
        await this.connectEvents(true);
    }

    async connectEvents(initialConnection = false) {
        if (!this.shouldRun) {
            return;
        }

        const eventUrl = this.createEventSocketUrl();

        try {
            const socket = new WebSocket(eventUrl, {
                handshakeTimeout: 10_000,
                perMessageDeflate: false,
            });
            this.eventSocket = socket;

            await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    reject(new Error('Délai de connexion au WebSocket ARI dépassé'));
                    socket.terminate();
                }, 12_000);

                socket.once('open', () => {
                    clearTimeout(timeout);
                    resolve();
                });
                socket.once('error', (error) => {
                    clearTimeout(timeout);
                    reject(error);
                });
            });

            this.connected = true;
            this.reconnectDelayMs = 1000;
            log('info', 'WebSocket ARI connecté');
            this.emit('connected');

            socket.on('message', (data, isBinary) => {
                if (isBinary) {
                    return;
                }

                try {
                    const event = JSON.parse(data.toString('utf8'));
                    this.emit('event', event);
                    this.emit(event.type, event);
                } catch (error) {
                    log('warn', 'Événement ARI JSON invalide', { error: errorText(error) });
                }
            });

            socket.on('close', (code, reason) => {
                if (socket !== this.eventSocket) {
                    return;
                }
                this.connected = false;
                log('warn', 'WebSocket ARI fermé', {
                    code,
                    reason: reason.toString('utf8'),
                });
                this.emit('disconnected');
                this.scheduleReconnect();
            });

            socket.on('error', (error) => {
                log('warn', 'Erreur WebSocket ARI', { error: errorText(error) });
            });
        } catch (error) {
            this.connected = false;
            if (initialConnection) {
                throw error;
            }
            log('error', 'Connexion ARI impossible', { error: errorText(error) });
            this.scheduleReconnect();
        }
    }

    scheduleReconnect() {
        if (!this.shouldRun || this.reconnectTimer) {
            return;
        }

        const delay = this.reconnectDelayMs;
        this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 30_000);
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            void this.connectEvents(false);
        }, delay);
    }

    async waitUntilConnected(timeoutMs = 10_000) {
        if (this.connected && this.eventSocket?.readyState === WebSocket.OPEN) {
            return;
        }

        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                cleanup();
                reject(new Error('ARI n’est pas connecté'));
            }, timeoutMs);

            const onConnected = () => {
                cleanup();
                resolve();
            };

            const cleanup = () => {
                clearTimeout(timeout);
                this.off('connected', onConnected);
            };

            this.on('connected', onConnected);
        });
    }

    async safeDelete(resourcePath, query = {}) {
        try {
            await this.request('DELETE', resourcePath, query);
        } catch (error) {
            if (!(error instanceof AriHttpError) || error.status !== 404) {
                log('warn', 'Suppression ARI échouée', {
                    resourcePath,
                    error: errorText(error),
                });
            }
        }
    }

    stop() {
        this.shouldRun = false;
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        this.eventSocket?.close(1000, 'Arrêt du service');
    }
}

class Pcm48StereoTo16Mono extends Transform {
    constructor() {
        super();
        this.remainder = Buffer.alloc(0);
    }

    _transform(chunk, encoding, callback) {
        try {
            const data = this.remainder.length
                ? Buffer.concat([this.remainder, chunk])
                : chunk;
            const inputBlockBytes = 12; // 3 échantillons, stéréo, 16 bits
            const blocks = Math.floor(data.length / inputBlockBytes);
            const usableBytes = blocks * inputBlockBytes;
            const output = Buffer.allocUnsafe(blocks * 2);

            for (let block = 0; block < blocks; block += 1) {
                const offset = block * inputBlockBytes;
                let sum = 0;
                for (let sample = 0; sample < 6; sample += 1) {
                    sum += data.readInt16LE(offset + sample * 2);
                }
                const mono = Math.max(-32768, Math.min(32767, Math.round(sum / 6)));
                output.writeInt16LE(mono, block * 2);
            }

            this.remainder = Buffer.from(data.subarray(usableBytes));
            if (output.length) {
                this.push(output);
            }
            callback();
        } catch (error) {
            callback(error);
        }
    }
}

class Pcm16MonoTo48Stereo extends Transform {
    constructor() {
        super();
        this.remainder = Buffer.alloc(0);
    }

    _transform(chunk, encoding, callback) {
        try {
            const data = this.remainder.length
                ? Buffer.concat([this.remainder, chunk])
                : chunk;
            const usableBytes = data.length - (data.length % 2);
            const sampleCount = usableBytes / 2;
            const output = Buffer.allocUnsafe(sampleCount * 12);

            for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
                const sample = data.readInt16LE(sampleIndex * 2);
                const outputOffset = sampleIndex * 12;
                for (let repeated = 0; repeated < 3; repeated += 1) {
                    const stereoOffset = outputOffset + repeated * 4;
                    output.writeInt16LE(sample, stereoOffset);
                    output.writeInt16LE(sample, stereoOffset + 2);
                }
            }

            this.remainder = Buffer.from(data.subarray(usableBytes));
            if (output.length) {
                this.push(output);
            }
            callback();
        } catch (error) {
            callback(error);
        }
    }
}

class AsteriskMediaSocket extends EventEmitter {
    constructor(url) {
        super();
        this.url = url;
        this.socket = null;
        this.frameSize = DEFAULT_MEDIA_FRAME_SIZE;
        this.pending = Buffer.alloc(0);
        this.canSend = true;
        this.started = false;
        this.closedByApplication = false;
        this.bytesReceived = 0;
        this.bytesSent = 0;
    }

    async connect() {
        const socket = new WebSocket(this.url, [MEDIA_SUBPROTOCOL], {
            handshakeTimeout: 10_000,
            perMessageDeflate: false,
        });
        this.socket = socket;
        this.attachHandlers();

        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                cleanup();
                socket.terminate();
                reject(new Error('Délai de connexion au WebSocket média dépassé'));
            }, 12_000);

            const cleanup = () => {
                clearTimeout(timeout);
                socket.off('error', onError);
                this.off('mediaStart', onMediaStart);
            };

            const onError = (error) => {
                cleanup();
                reject(error);
            };

            const onMediaStart = () => {
                cleanup();
                resolve();
            };

            socket.once('error', onError);
            this.once('mediaStart', onMediaStart);
        });
    }

    attachHandlers() {
        if (!this.socket) {
            throw new Error('Socket média absent');
        }

        this.socket.on('message', (data, isBinary) => {
            if (isBinary) {
                this.bytesReceived += data.length;
                this.emit('audio', Buffer.from(data));
                return;
            }

            const message = data.toString('utf8').trim();
            this.handleControlMessage(message);
        });

        this.socket.on('close', (code, reason) => {
            this.emit('closed', {
                code,
                reason: reason.toString('utf8'),
                expected: this.closedByApplication,
            });
        });

        this.socket.on('error', (error) => {
            this.emit('socketError', error);
        });
    }

    handleControlMessage(message) {
        let eventName = message.split(/\s+/u, 1)[0];
        let event = {};

        try {
            const parsed = JSON.parse(message);
            eventName = parsed.event || parsed.command || eventName;
            event = parsed;
        } catch {
            for (const token of message.split(/\s+/u).slice(1)) {
                const separator = token.indexOf(':');
                if (separator > 0) {
                    event[token.slice(0, separator)] = token.slice(separator + 1);
                }
            }
        }

        if (eventName === 'MEDIA_START') {
            const optimalSize = Number.parseInt(event.optimal_frame_size, 10);
            if (Number.isInteger(optimalSize) && optimalSize > 0) {
                this.frameSize = optimalSize;
            }
            this.started = true;
            this.emit('mediaStart', event);
        } else if (eventName === 'MEDIA_XOFF') {
            this.canSend = false;
            this.pending = Buffer.alloc(0);
        } else if (eventName === 'MEDIA_XON') {
            this.canSend = true;
        }

        this.emit('control', { name: eventName, data: event, raw: message });
    }

    sendPcm(chunk) {
        if (
            !this.started
            || !this.canSend
            || !this.socket
            || this.socket.readyState !== WebSocket.OPEN
            || this.socket.bufferedAmount > MAX_MEDIA_WS_BUFFER
        ) {
            return false;
        }

        this.pending = this.pending.length
            ? Buffer.concat([this.pending, chunk])
            : Buffer.from(chunk);

        while (this.pending.length >= this.frameSize) {
            const frame = this.pending.subarray(0, this.frameSize);
            this.socket.send(frame, { binary: true });
            this.bytesSent += frame.length;
            this.pending = Buffer.from(this.pending.subarray(this.frameSize));
        }

        return true;
    }

    flushInput() {
        this.pending = Buffer.alloc(0);
    }

    close() {
        this.closedByApplication = true;
        this.pending = Buffer.alloc(0);
        if (this.socket?.readyState === WebSocket.OPEN) {
            this.socket.close(1000, 'Fin de l’appel');
        } else if (this.socket?.readyState === WebSocket.CONNECTING) {
            this.socket.terminate();
        }
    }
}

class CallManager {
    constructor(discordClient, ariClient) {
        this.discordClient = discordClient;
        this.ari = ariClient;
        this.sessionsByGuild = new Map();
        this.sessionsById = new Map();
        this.sessionsByChannelId = new Map();
        this.userCallHistory = new Map();

        this.ari.on('event', (event) => {
            void this.handleAriEvent(event);
        });

        this.ari.on('disconnected', () => {
            for (const session of this.sessionsByGuild.values()) {
                void this.endCall(session, 'Connexion ARI perdue');
            }
        });
    }

    activeCallCount() {
        return this.sessionsByGuild.size;
    }

    getSessionByGuild(guildId) {
        return this.sessionsByGuild.get(guildId) ?? null;
    }

    getSessionById(sessionId) {
        return this.sessionsById.get(sessionId) ?? null;
    }

    isPrivileged(member) {
        if (member.id === member.guild.ownerId) {
            return true;
        }

        if (config.allowedUserIds.has(member.id)) {
            return true;
        }

        if ([...config.allowedRoleIds].some((roleId) => member.roles.cache.has(roleId))) {
            return true;
        }

        if (config.allowedUserIds.size === 0 && config.allowedRoleIds.size === 0) {
            return member.permissions.has(PermissionFlagsBits.Administrator);
        }

        return false;
    }

    mayControlSession(member, session) {
        if (config.restrictCommandsToAuthorizedOnly) {
            return this.isPrivileged(member);
        }

        return member.id === session.initiatorId || this.isPrivileged(member);
    }

    startStatusRefresh(session) {
        this.stopStatusRefresh(session);

        if (config.statusRefreshIntervalSeconds <= 0 || session.state === 'ended') {
            return;
        }

        session.statusRefreshTimer = setInterval(() => {
            if (session.ending || session.state === 'ended') {
                this.stopStatusRefresh(session);
                return;
            }
            void this.refreshStatusDisplay(session);
        }, config.statusRefreshIntervalSeconds * 1000);
    }

    stopStatusRefresh(session) {
        if (session.statusRefreshTimer) {
            clearInterval(session.statusRefreshTimer);
            session.statusRefreshTimer = null;
        }
    }

    async refreshStatusDisplay(session) {
        if (!session.statusMessage || session.ending || session.state === 'ended') {
            return;
        }

        try {
            await session.statusMessage.edit(
                this.buildStatusPayload(session, session.statusDetail),
            );
        } catch (error) {
            log('warn', 'Actualisation périodique du message d’état impossible', {
                sessionId: session.id,
                error: errorText(error),
            });
        }
    }

    checkAndRecordRateLimit(userId) {
        const now = Date.now();
        const oneHourAgo = now - 3_600_000;
        const recentCalls = (this.userCallHistory.get(userId) ?? [])
            .filter((timestamp) => timestamp > oneHourAgo);

        if (recentCalls.length >= config.callsPerHourPerUser) {
            throw new Error(
                `Limite atteinte: ${config.callsPerHourPerUser} appels par heure et par utilisateur.`,
            );
        }

        recentCalls.push(now);
        this.userCallHistory.set(userId, recentCalls);
    }

    async waitForVoiceConnectionReady(session) {
        const timeoutMs = config.voiceConnectionTimeoutSeconds * 1000;

        try {
            await entersState(
                session.voiceConnection,
                VoiceConnectionStatus.Ready,
                timeoutMs,
            );
        } catch (error) {
            const currentStatus = session.voiceConnection?.state?.status ?? 'inconnu';

            log('error', 'Connexion au salon vocal Discord impossible', {
                sessionId: session.id,
                guildId: session.guildId,
                voiceChannelId: session.voiceChannelId,
                currentStatus,
                timeoutMs,
                error: errorText(error),
            });

            throw new Error(
                `Connexion au salon vocal Discord impossible après `
                + `${config.voiceConnectionTimeoutSeconds} secondes `
                + `(état final: ${currentStatus})`,
                { cause: error },
            );
        }
    }

    async startCall(interaction, rawNumber) {
        if (!interaction.inGuild() || !interaction.guild) {
            throw new Error('Cette commande doit être utilisée dans un serveur Discord.');
        }

        const member = await interaction.guild.members.fetch(interaction.user.id);
        if (config.restrictCommandsToAuthorizedOnly && !this.isPrivileged(member)) {
            throw new Error('Tu n’es pas autorisé à lancer un appel téléphonique.');
        }

        const voiceChannel = member.voice.channel;
        if (!voiceChannel?.isVoiceBased()) {
            throw new Error('Tu dois être présent dans un salon vocal avant de lancer l’appel.');
        }

        if (this.sessionsByGuild.has(interaction.guildId)) {
            throw new Error('Un appel est déjà actif dans ce serveur Discord.');
        }

        if (this.activeCallCount() >= config.maxConcurrentCalls) {
            throw new Error(`La limite globale de ${config.maxConcurrentCalls} appel(s) simultané(s) est atteinte.`);
        }

        const botMember = interaction.guild.members.me
            ?? await interaction.guild.members.fetchMe();
        const voicePermissions = voiceChannel.permissionsFor(botMember);
        for (const permission of [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.Connect,
            PermissionFlagsBits.Speak,
        ]) {
            if (!voicePermissions?.has(permission)) {
                if (voiceChannel.type === ChannelType.GuildStageVoice) {
                    throw new Error(
                        'Le bot n’a pas les permissions nécessaires dans ce salon Stage (Voir, Se connecter, Parler).',
                    );
                }
                throw new Error('Le bot n’a pas les permissions Voir, Se connecter et Parler dans ce salon vocal.');
            }
        }

        const number = normalizePhoneNumber(rawNumber);
        const dialNumber = resolveDialNumber(number);
        this.checkAndRecordRateLimit(member.id);
        await this.ari.waitUntilConnected();

        const sessionId = randomUUID();
        const session = {
            id: sessionId,
            guildId: interaction.guildId,
            guild: interaction.guild,
            initiatorId: member.id,
            initiatorTag: interaction.user.tag,
            voiceChannelId: voiceChannel.id,
            voiceChannel,
            number,
            dialNumber,
            maskedNumber: formatPhoneNumberForDisplay(number),
            state: 'preparing',
            startedAt: Date.now(),
            answeredAt: null,
            endedAt: null,
            ending: false,
            muted: false,
            statusMessage: null,
            statusDetail: '',
            statusRefreshTimer: null,
            voiceConnection: null,
            audioPlayer: null,
            audioSubscription: null,
            phoneToDiscordStream: null,
            phoneToDiscordTransform: null,
            discordReceiveStream: null,
            opusDecoder: null,
            discordToPhoneTransform: null,
            mediaSocket: null,
            mediaChannelId: `media-${sessionId}`,
            phoneChannelId: `phone-${sessionId}`,
            bridgeId: `bridge-${sessionId}`,
            asteriskMediaCreated: false,
            asteriskBridgeCreated: false,
            asteriskPhoneChannelCreated: false,
            callTimeoutTimer: null,
            maxDurationTimer: null,
            discordPcmBytes: 0,
            audioDiagTimer: null,
        };

        this.sessionsByGuild.set(session.guildId, session);
        this.sessionsById.set(session.id, session);
        this.sessionsByChannelId.set(session.mediaChannelId, session);
        this.sessionsByChannelId.set(session.phoneChannelId, session);

        try {
            session.statusMessage = await interaction.editReply(
                this.buildStatusPayload(session, 'Préparation de l’appel'),
            );
            this.startStatusRefresh(session);

            session.voiceConnection = joinVoiceChannel({
                channelId: voiceChannel.id,
                guildId: interaction.guildId,
                adapterCreator: interaction.guild.voiceAdapterCreator,
                selfDeaf: false,
                selfMute: false,
                group: `sip-${interaction.guildId}`,
                daveEncryption: config.voiceDaveEncryption,
                decryptionFailureTolerance: 24,
                debug: config.voiceDebug,
            });

            session.voiceConnection.on('stateChange', (oldState, newState) => {
                log('info', 'État vocal Discord modifié', {
                    sessionId: session.id,
                    guildId: session.guildId,
                    voiceChannelId: session.voiceChannelId,
                    previousStatus: oldState.status,
                    newStatus: newState.status,
                });
            });

            session.voiceConnection.on('debug', (message) => {
                if (config.voiceDebug) {
                    log('info', 'Diagnostic vocal Discord', {
                        sessionId: session.id,
                        message,
                    });
                }
            });

            session.voiceConnection.on(VoiceConnectionStatus.Disconnected, () => {
                void this.handleVoiceConnectionDisconnected(session);
            });
            session.voiceConnection.on('error', (error) => {
                log('error', 'Erreur de connexion vocale Discord', {
                    sessionId,
                    currentStatus: session.voiceConnection?.state?.status ?? 'inconnu',
                    error: errorText(error),
                });
                void this.endCall(session, 'Erreur de connexion vocale Discord');
            });

            await this.waitForVoiceConnectionReady(session);
            log('info', 'Connexion vocale Discord prête', {
                sessionId: session.id,
                guildId: session.guildId,
                voiceChannelId: session.voiceChannelId,
            });
            this.configureDiscordAudio(session);
            await this.updateStatus(session, 'preparing', 'Connexion à Asterisk');

            await this.createAsteriskMedia(session);
            await this.createAsteriskCall(session);

            session.maxDurationTimer = setTimeout(() => {
                void this.endCall(session, 'Durée maximale atteinte');
            }, config.maxCallDurationSeconds * 1000);

            session.callTimeoutTimer = setTimeout(() => {
                if (!session.answeredAt) {
                    void this.endCall(session, 'Aucune réponse dans le délai autorisé');
                }
            }, (config.callTimeoutSeconds + 5) * 1000);

            this.startAudioDiagnostics(session);

            await this.updateStatus(session, 'dialing', 'Numérotation en cours');
            if (session.dialNumber !== session.number) {
                log('info', 'Préfixe de sortie Yeastar appliqué', {
                    sessionId,
                    prefix: session.dialNumber.slice(0, session.dialNumber.length - session.number.length),
                    number: session.maskedNumber,
                });
            }
            log('info', 'Appel lancé', {
                sessionId,
                guildId: session.guildId,
                userId: session.initiatorId,
                number: session.maskedNumber,
            });

            return session;
        } catch (error) {
            log('error', 'Échec de préparation de l’appel', {
                sessionId,
                error: errorText(error),
            });
            await this.endCall(session, `Échec du lancement: ${errorText(error)}`);
            throw error;
        }
    }

    startAudioDiagnostics(session) {
        if (!config.audioDebug || session.audioDiagTimer) {
            return;
        }

        let previousPhoneToDiscord = 0;
        let previousDiscordToPhone = 0;
        let previousDiscordPcm = 0;

        session.audioDiagTimer = setInterval(() => {
            if (session.ending) {
                return;
            }

            const phoneToDiscord = session.mediaSocket?.bytesReceived ?? 0;
            const discordToPhone = session.mediaSocket?.bytesSent ?? 0;
            const discordPcm = session.discordPcmBytes;

            log('info', 'Diagnostic audio', {
                sessionId: session.id,
                state: session.state,
                muted: session.muted,
                // Téléphone -> Discord : octets reçus du WebSocket média Asterisk
                phoneToDiscordTotal: phoneToDiscord,
                phoneToDiscordDelta: phoneToDiscord - previousPhoneToDiscord,
                // Discord -> téléphone : PCM décodé depuis Discord, puis octets poussés vers Asterisk
                discordPcmDelta: discordPcm - previousDiscordPcm,
                discordToPhoneTotal: discordToPhone,
                discordToPhoneDelta: discordToPhone - previousDiscordToPhone,
            });

            previousPhoneToDiscord = phoneToDiscord;
            previousDiscordToPhone = discordToPhone;
            previousDiscordPcm = discordPcm;
        }, 2000);
    }

    stopAudioDiagnostics(session) {
        if (session.audioDiagTimer) {
            clearInterval(session.audioDiagTimer);
            session.audioDiagTimer = null;
        }
    }

    configureDiscordAudio(session) {
        session.phoneToDiscordStream = new PassThrough({
            highWaterMark: MAX_DISCORD_PCM_BUFFER,
        });
        session.phoneToDiscordTransform = new Pcm16MonoTo48Stereo();
        session.phoneToDiscordTransform.pipe(session.phoneToDiscordStream);

        session.audioPlayer = createAudioPlayer({
            behaviors: {
                noSubscriber: NoSubscriberBehavior.Pause,
            },
        });

        const resource = createAudioResource(session.phoneToDiscordStream, {
            inputType: StreamType.Raw,
        });
        session.audioPlayer.play(resource);
        const subscription = session.voiceConnection.subscribe(session.audioPlayer);
        if (!subscription) {
            throw new Error(
                'Impossible d’abonner le lecteur audio à la connexion vocale Discord.',
            );
        }
        session.audioSubscription = subscription;

        session.audioPlayer.on('error', (error) => {
            log('error', 'Erreur du lecteur audio Discord', {
                sessionId: session.id,
                error: errorText(error),
            });
            void this.endCall(session, 'Erreur du lecteur audio Discord');
        });

        session.audioPlayer.on(AudioPlayerStatus.Idle, () => {
            if (!session.ending) {
                log('warn', 'Le lecteur Discord est passé à Idle pendant un appel', {
                    sessionId: session.id,
                });
            }
        });

        session.discordReceiveStream = session.voiceConnection.receiver.subscribe(
            session.initiatorId,
            {
                end: {
                    behavior: EndBehaviorType.Manual,
                },
            },
        );

        session.opusDecoder = new prism.opus.Decoder({
            rate: 48_000,
            channels: 2,
            frameSize: 960,
        });
        session.discordToPhoneTransform = new Pcm48StereoTo16Mono();

        session.discordReceiveStream
            .pipe(session.opusDecoder)
            .pipe(session.discordToPhoneTransform);

        session.discordToPhoneTransform.on('data', (pcm) => {
            session.discordPcmBytes += pcm.length;
            if (!session.ending && !session.muted) {
                session.mediaSocket?.sendPcm(pcm);
            }
        });

        for (const stream of [
            session.discordReceiveStream,
            session.opusDecoder,
            session.discordToPhoneTransform,
        ]) {
            stream.on('error', (error) => {
                if (!session.ending) {
                    log('error', 'Erreur du flux Discord vers téléphone', {
                        sessionId: session.id,
                        error: errorText(error),
                    });
                    void this.endCall(session, 'Erreur du flux audio Discord');
                }
            });
        }
    }

    async createAsteriskMedia(session) {
        await this.ari.request('POST', 'channels/externalMedia', {
            channelId: session.mediaChannelId,
            app: config.ariApplication,
            external_host: 'INCOMING',
            encapsulation: 'none',
            transport: 'websocket',
            connection_type: 'server',
            format: 'slin16',
            direction: 'both',
            data: session.id,
            transport_data: 'f(json)',
        });

        let connectionId = null;
        for (let attempt = 0; attempt < 40; attempt += 1) {
            try {
                const response = await this.ari.request(
                    'GET',
                    `channels/${encodeURIComponent(session.mediaChannelId)}/variable`,
                    { variable: 'MEDIA_WEBSOCKET_CONNECTION_ID' },
                );
                connectionId = response?.value;
                if (connectionId) {
                    break;
                }
            } catch (error) {
                if (!(error instanceof AriHttpError) || ![404, 409].includes(error.status)) {
                    throw error;
                }
            }
            await sleep(100);
        }

        if (!connectionId) {
            throw new Error('Asterisk n’a pas fourni MEDIA_WEBSOCKET_CONNECTION_ID');
        }

        session.mediaSocket = new AsteriskMediaSocket(
            this.ari.createMediaSocketUrl(connectionId),
        );
        session.mediaSocket.on('audio', (pcm) => {
            if (session.ending || !session.phoneToDiscordTransform) {
                return;
            }

            if ((session.phoneToDiscordStream?.writableLength ?? 0) > MAX_DISCORD_PCM_BUFFER) {
                return;
            }
            session.phoneToDiscordTransform.write(pcm);
        });

        session.mediaSocket.on('closed', ({ expected, code, reason }) => {
            if (!expected && !session.ending) {
                log('warn', 'WebSocket média fermé de façon inattendue', {
                    sessionId: session.id,
                    code,
                    reason,
                });
                void this.endCall(session, 'Connexion audio Asterisk interrompue');
            }
        });

        session.mediaSocket.on('socketError', (error) => {
            if (!session.ending) {
                log('error', 'Erreur WebSocket média', {
                    sessionId: session.id,
                    error: errorText(error),
                });
            }
        });

        await session.mediaSocket.connect();
        session.asteriskMediaCreated = true;
    }

    async createAsteriskCall(session) {
        await this.ari.request(
            'POST',
            `bridges/${encodeURIComponent(session.bridgeId)}`,
            {
                type: 'mixing',
                name: `discord-${session.guildId}`,
            },
        );
        session.asteriskBridgeCreated = true;

        await this.ari.request(
            'POST',
            'channels/create',
            {
                endpoint: `PJSIP/${session.dialNumber}@${config.pjsipEndpoint}`,
                app: config.ariApplication,
                appArgs: `phone,${session.id}`,
                channelId: session.phoneChannelId,
                formats: 'alaw,ulaw',
            },
            {
                variables: {
                    'CALLERID(name)': config.callerIdName,
                    'CALLERID(num)': config.callerIdNumber,
                    DISCORD_SESSION_ID: session.id,
                    DISCORD_GUILD_ID: session.guildId,
                    DISCORD_USER_ID: session.initiatorId,
                },
            },
        );
        session.asteriskPhoneChannelCreated = true;

        await this.ari.request(
            'POST',
            `bridges/${encodeURIComponent(session.bridgeId)}/addChannel`,
            { channel: session.mediaChannelId },
        );
        await this.ari.request(
            'POST',
            `bridges/${encodeURIComponent(session.bridgeId)}/addChannel`,
            { channel: session.phoneChannelId },
        );

        await this.ari.request(
            'POST',
            `channels/${encodeURIComponent(session.phoneChannelId)}/dial`,
            { timeout: config.callTimeoutSeconds },
        );
    }

    async handleAriEvent(event) {
        const channelIds = [
            event.channel?.id,
            event.peer?.id,
            event.caller?.id,
            event.dialed?.id,
        ].filter(Boolean);

        const session = channelIds
            .map((channelId) => this.sessionsByChannelId.get(channelId))
            .find(Boolean);

        if (!session || session.ending) {
            return;
        }

        if (event.type === 'ChannelStateChange' && event.channel?.id === session.phoneChannelId) {
            const state = event.channel.state;
            if (state === 'Ringing' || state === 'Ring') {
                await this.updateStatus(session, 'ringing', 'Le téléphone sonne');
            } else if (state === 'Up') {
                await this.markAnswered(session);
            }
            return;
        }

        if (event.type === 'Dial' && event.peer?.id === session.phoneChannelId) {
            const dialStatus = event.dialstatus;
            if (dialStatus === 'RINGING' || dialStatus === 'PROGRESS') {
                await this.updateStatus(session, 'ringing', 'Le téléphone sonne');
            } else if (dialStatus === 'ANSWER') {
                await this.markAnswered(session);
            } else if (['BUSY', 'NOANSWER', 'CHANUNAVAIL', 'CONGESTION', 'DONTCALL', 'TORTURE'].includes(dialStatus)) {
                await this.endCall(session, `Appel terminé: ${dialStatus}`);
            }
            return;
        }

        if (event.type === 'ChannelDestroyed' && event.channel?.id === session.phoneChannelId) {
            const reason = event.cause_txt || `cause ${event.cause ?? 'inconnue'}`;
            await this.endCall(session, `Canal téléphonique terminé: ${reason}`);
            return;
        }

        if (event.type === 'StasisEnd' && event.channel?.id === session.phoneChannelId) {
            await this.endCall(session, 'Le correspondant a raccroché');
            return;
        }

        if (
            (event.type === 'ChannelDestroyed' || event.type === 'StasisEnd')
            && event.channel?.id === session.mediaChannelId
        ) {
            await this.endCall(session, 'Canal audio Asterisk terminé');
        }
    }

    async markAnswered(session) {
        if (session.answeredAt || session.ending) {
            return;
        }

        session.answeredAt = Date.now();
        if (session.callTimeoutTimer) {
            clearTimeout(session.callTimeoutTimer);
            session.callTimeoutTimer = null;
        }
        await this.updateStatus(session, 'connected', 'Appel connecté');
    }

    async sendDtmf(session, digits) {
        if (!session || session.ending) {
            throw new Error('Aucun appel actif.');
        }
        if (!/^[0-9A-D*#]+$/iu.test(digits)) {
            throw new Error('Les touches DTMF autorisées sont 0-9, A-D, * et #.');
        }

        await this.ari.request(
            'POST',
            `channels/${encodeURIComponent(session.phoneChannelId)}/dtmf`,
            {
                dtmf: digits.toUpperCase(),
                before: 100,
                between: 150,
                duration: 150,
                after: 100,
            },
        );
    }

    async toggleMute(session) {
        if (!session || session.ending) {
            throw new Error('Aucun appel actif.');
        }

        session.muted = !session.muted;
        if (session.muted) {
            session.mediaSocket?.flushInput();
        }
        await this.updateStatus(
            session,
            session.state,
            session.muted ? 'Micro Discord coupé vers le téléphone' : 'Micro Discord réactivé',
        );
        return session.muted;
    }

    async handleVoiceConnectionDisconnected(session) {
        if (session.ending) {
            return;
        }

        try {
            await Promise.race([
                entersState(session.voiceConnection, VoiceConnectionStatus.Signalling, 5_000),
                entersState(session.voiceConnection, VoiceConnectionStatus.Connecting, 5_000),
                entersState(session.voiceConnection, VoiceConnectionStatus.Ready, 5_000),
            ]);
        } catch {
            await this.endCall(session, 'Le bot a perdu le salon vocal');
        }
    }

    async handleVoiceStateUpdate(oldState, newState) {
        const session = this.sessionsByGuild.get(oldState.guild.id);
        if (!session || session.ending) {
            return;
        }

        if (newState.id === this.discordClient.user.id) {
            if (newState.channelId !== session.voiceChannelId) {
                await this.endCall(session, 'Le bot a été déconnecté ou déplacé du salon vocal');
            }
            return;
        }

        if (newState.id === session.initiatorId && newState.channelId !== session.voiceChannelId) {
            await this.endCall(session, 'L’initiateur a quitté ou changé de salon vocal');
            return;
        }

        const channel = session.guild.channels.cache.get(session.voiceChannelId);
        if (channel?.isVoiceBased()) {
            const humanMembers = channel.members.filter((member) => !member.user.bot);
            if (humanMembers.size === 0) {
                await this.endCall(session, 'Le salon vocal est vide');
            }
        }
    }

    async endCall(session, reason = 'Appel terminé') {
        if (!session || session.ending) {
            return;
        }
        session.ending = true;
        session.endedAt = Date.now();
        this.stopStatusRefresh(session);
        this.stopAudioDiagnostics(session);

        if (session.callTimeoutTimer) {
            clearTimeout(session.callTimeoutTimer);
        }
        if (session.maxDurationTimer) {
            clearTimeout(session.maxDurationTimer);
        }

        session.discordReceiveStream?.destroy();
        session.opusDecoder?.destroy();
        session.discordToPhoneTransform?.destroy();
        session.phoneToDiscordTransform?.end();
        session.phoneToDiscordStream?.end();
        session.audioSubscription?.unsubscribe();
        session.audioPlayer?.stop(true);
        session.mediaSocket?.close();

        const cleanupPromises = [];
        if (session.asteriskPhoneChannelCreated) {
            cleanupPromises.push(
                this.ari.safeDelete(
                    `channels/${encodeURIComponent(session.phoneChannelId)}`,
                    { reason: 'normal' },
                ),
            );
        }
        if (session.asteriskMediaCreated) {
            cleanupPromises.push(
                this.ari.safeDelete(
                    `channels/${encodeURIComponent(session.mediaChannelId)}`,
                    { reason: 'normal' },
                ),
            );
        }
        if (session.asteriskBridgeCreated) {
            cleanupPromises.push(
                this.ari.safeDelete(`bridges/${encodeURIComponent(session.bridgeId)}`),
            );
        }
        await Promise.allSettled(cleanupPromises);

        try {
            session.voiceConnection?.destroy();
        } catch {
            // Connexion déjà détruite.
        }

        this.sessionsByGuild.delete(session.guildId);
        this.sessionsById.delete(session.id);
        this.sessionsByChannelId.delete(session.mediaChannelId);
        this.sessionsByChannelId.delete(session.phoneChannelId);

        await this.updateStatus(session, 'ended', reason);
        log('info', 'Appel terminé', {
            sessionId: session.id,
            guildId: session.guildId,
            userId: session.initiatorId,
            number: session.maskedNumber,
            reason,
            durationSeconds: Math.floor((session.endedAt - session.startedAt) / 1000),
        });
    }

    buildStatusPayload(session, detail) {
        const labels = {
            preparing: 'Préparation',
            dialing: 'Numérotation',
            ringing: 'Sonnerie',
            connected: 'Connecté',
            ended: 'Terminé',
        };

        const referenceTime = session.endedAt ?? Date.now();
        const durationStart = session.answeredAt ?? session.startedAt;
        const duration = formatDuration((referenceTime - durationStart) / 1000);

        const embed = new EmbedBuilder()
            .setTitle('Passerelle téléphonique Discord')
            .addFields(
                { name: 'État', value: labels[session.state] ?? session.state, inline: true },
                { name: 'Numéro', value: session.maskedNumber, inline: true },
                { name: 'Durée', value: duration, inline: true },
                { name: 'Initiateur', value: `<@${session.initiatorId}>`, inline: true },
                { name: 'Salon vocal', value: `<#${session.voiceChannelId}>`, inline: true },
                { name: 'Micro vers téléphone', value: session.muted ? 'Coupé' : 'Actif', inline: true },
                { name: 'Information', value: detail || 'Aucune', inline: false },
            )
            .setTimestamp(new Date(referenceTime));

        const components = [];
        if (session.state !== 'ended') {
            components.push(
                new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setCustomId(`sip:mute:${session.id}`)
                        .setLabel(session.muted ? 'Réactiver le micro' : 'Couper le micro')
                        .setStyle(ButtonStyle.Secondary),
                    new ButtonBuilder()
                        .setCustomId(`sip:hangup:${session.id}`)
                        .setLabel('Raccrocher')
                        .setStyle(ButtonStyle.Danger),
                ),
            );
        }

        return {
            embeds: [embed],
            components,
            allowedMentions: { parse: [] },
        };
    }

    async updateStatus(session, state, detail) {
        session.state = state;
        session.statusDetail = detail;
        if (!session.statusMessage) {
            return;
        }

        try {
            await session.statusMessage.edit(this.buildStatusPayload(session, detail));
        } catch (error) {
            log('warn', 'Mise à jour du message d’état impossible', {
                sessionId: session.id,
                error: errorText(error),
            });
        }

        if (state === 'ended') {
            this.stopStatusRefresh(session);
        } else if (!session.statusRefreshTimer) {
            this.startStatusRefresh(session);
        }
    }

    async endAll(reason) {
        await Promise.allSettled(
            [...this.sessionsByGuild.values()].map((session) => this.endCall(session, reason)),
        );
    }
}

const commandDefinitions = [
    new SlashCommandBuilder()
        .setName('appeler')
        .setDescription('Appeler un numéro avec la ligne Yeastar depuis le salon vocal')
        .addStringOption((option) => option
            .setName('numero')
            .setDescription('Numéro autorisé par la configuration du bot')
            .setRequired(true)),
    new SlashCommandBuilder()
        .setName('raccrocher')
        .setDescription('Terminer l’appel téléphonique actif'),
    new SlashCommandBuilder()
        .setName('muet')
        .setDescription('Couper ou réactiver ta voix vers le correspondant téléphonique'),
    new SlashCommandBuilder()
        .setName('dtmf')
        .setDescription('Envoyer des touches DTMF pendant l’appel')
        .addStringOption((option) => option
            .setName('touches')
            .setDescription('Touches 0-9, A-D, * ou #')
            .setRequired(true)),
    new SlashCommandBuilder()
        .setName('statut-appel')
        .setDescription('Afficher l’état de l’appel actif'),
].map((command) => command.toJSON());

const discordClient = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
    ],
});

const ariClient = new AriClient({
    baseUrl: config.ariBaseUrl,
    username: config.ariUsername,
    password: config.ariPassword,
    application: config.ariApplication,
});
const callManager = new CallManager(discordClient, ariClient);

async function registerDiscordCommands() {
    if (!config.registerCommands) {
        return;
    }

    if (config.discordGuildId) {
        await discordClient.application.commands.set(
            commandDefinitions,
            config.discordGuildId,
        );
        log('info', 'Commandes Discord enregistrées dans le serveur', {
            guildId: config.discordGuildId,
        });
        if (config.restrictCommandsToVoiceText) {
            log('info', 'RESTRICT_COMMANDS_TO_VOICE_TEXT actif : contrôle à l’exécution uniquement. Pour masquer les commandes dans l’interface Discord, configurez les salons dans Paramètres du serveur → Intégrations → le bot.');
        }
    } else {
        if (config.restrictCommandsToVoiceText) {
            log('warn', 'RESTRICT_COMMANDS_TO_VOICE_TEXT nécessite DISCORD_GUILD_ID pour un contrôle fiable par serveur.');
        }
        await discordClient.application.commands.set(commandDefinitions);
        log('info', 'Commandes Discord globales enregistrées');
    }
}

async function getInteractionMember(interaction) {
    if (!interaction.inGuild() || !interaction.guild) {
        throw new Error('Cette action doit être utilisée dans un serveur Discord.');
    }
    return interaction.guild.members.fetch(interaction.user.id);
}

async function assertInteractionAllowed(interaction) {
    assertVoiceChannelTextChat(interaction);

    const member = await getInteractionMember(interaction);
    if (config.restrictCommandsToAuthorizedOnly && !callManager.isPrivileged(member)) {
        throw new Error('Tu n’es pas autorisé à utiliser les commandes du bot.');
    }

    return member;
}

async function handleSlashCommand(interaction) {
    if (interaction.commandName === 'appeler') {
        await interaction.deferReply();
        try {
            await assertInteractionAllowed(interaction);
            await callManager.startCall(
                interaction,
                interaction.options.getString('numero', true),
            );
        } catch (error) {
            const message = `Appel non lancé: ${errorText(error)}`;
            if (interaction.deferred || interaction.replied) {
                await interaction.editReply({ content: message, embeds: [], components: [] });
            } else {
                await interaction.reply({ content: message, ephemeral: true });
            }
        }
        return;
    }

    await interaction.deferReply({ ephemeral: true });

    try {
        const member = await assertInteractionAllowed(interaction);
        const session = callManager.getSessionByGuild(interaction.guildId);

        if (!session) {
            throw new Error('Aucun appel actif dans ce serveur.');
        }
        if (!callManager.mayControlSession(member, session)) {
            throw new Error('Tu n’es pas autorisé à contrôler cet appel.');
        }

        if (interaction.commandName === 'raccrocher') {
            await callManager.endCall(session, `Appel raccroché par ${interaction.user.tag}`);
            await interaction.editReply('Appel terminé.');
        } else if (interaction.commandName === 'muet') {
            const muted = await callManager.toggleMute(session);
            await interaction.editReply(
                muted
                    ? 'Ta voix n’est plus envoyée vers le téléphone.'
                    : 'Ta voix est de nouveau envoyée vers le téléphone.',
            );
        } else if (interaction.commandName === 'dtmf') {
            const digits = interaction.options.getString('touches', true).trim();
            await callManager.sendDtmf(session, digits);
            await interaction.editReply(`Touches DTMF envoyées: \`${digits}\``);
        } else if (interaction.commandName === 'statut-appel') {
            await interaction.editReply({
                embeds: callManager.buildStatusPayload(session, 'État demandé manuellement').embeds,
            });
        }
    } catch (error) {
        await interaction.editReply(`Action impossible: ${errorText(error)}`);
    }
}

async function handleButton(interaction) {
    const [namespace, action, sessionId] = interaction.customId.split(':');
    if (namespace !== 'sip' || !sessionId) {
        return;
    }

    await interaction.deferReply({ ephemeral: true });

    try {
        const member = await assertInteractionAllowed(interaction);
        const session = callManager.getSessionById(sessionId);
        if (!session || session.guildId !== interaction.guildId) {
            throw new Error('Cet appel n’est plus actif.');
        }
        if (!callManager.mayControlSession(member, session)) {
            throw new Error('Tu n’es pas autorisé à contrôler cet appel.');
        }

        if (action === 'hangup') {
            await callManager.endCall(session, `Appel raccroché par ${interaction.user.tag}`);
            await interaction.editReply('Appel terminé.');
        } else if (action === 'mute') {
            const muted = await callManager.toggleMute(session);
            await interaction.editReply(
                muted
                    ? 'Ta voix n’est plus envoyée vers le téléphone.'
                    : 'Ta voix est de nouveau envoyée vers le téléphone.',
            );
        }
    } catch (error) {
        await interaction.editReply(`Action impossible: ${errorText(error)}`);
    }
}

discordClient.once(Events.ClientReady, async () => {
    log('info', 'Bot Discord connecté', {
        user: discordClient.user.tag,
        guilds: discordClient.guilds.cache.size,
    });

    try {
        await registerDiscordCommands();
    } catch (error) {
        log('error', 'Enregistrement des commandes Discord impossible', {
            error: errorText(error),
        });
    }
});

discordClient.on('interactionCreate', (interaction) => {
    if (interaction.isChatInputCommand()) {
        void handleSlashCommand(interaction);
    } else if (interaction.isButton()) {
        void handleButton(interaction);
    }
});

discordClient.on('voiceStateUpdate', (oldState, newState) => {
    void callManager.handleVoiceStateUpdate(oldState, newState);
});

discordClient.on('error', (error) => {
    log('error', 'Erreur du client Discord', { error: errorText(error) });
});

process.on('unhandledRejection', (reason) => {
    log('error', 'Promise rejetée sans gestion', { error: errorText(reason) });
});

process.on('uncaughtException', (error) => {
    log('error', 'Exception non interceptée', { error: errorText(error) });
});

let shuttingDown = false;
async function shutdown(signal) {
    if (shuttingDown) {
        return;
    }
    shuttingDown = true;
    log('info', `Arrêt demandé par ${signal}`);

    const hardStop = setTimeout(() => {
        process.exit(1);
    }, 15_000);
    hardStop.unref();

    await callManager.endAll(`Arrêt du service (${signal})`);
    ariClient.stop();
    discordClient.destroy();
    process.exit(0);
}

process.once('SIGINT', () => {
    void shutdown('SIGINT');
});
process.once('SIGTERM', () => {
    void shutdown('SIGTERM');
});

async function main() {
    log('info', 'Rapport des dépendances vocales Discord');
    console.info(generateDependencyReport());
    await ariClient.start();
    await discordClient.login(config.discordToken);
}

main().catch((error) => {
    log('error', 'Démarrage impossible', { error: errorText(error) });
    process.exit(1);
});
