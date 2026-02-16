const { Telegraf, Markup, Scenes, session } = require('telegraf');
const os = require('os');
const util = require('util');
const pidusage = util.promisify(require('pidusage'));
const bedrock = require('bedrock-protocol');
const { statusBedrock } = require('minecraft-server-util');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

// --- JSON Database Management (Optimized) ---
const dataDir = path.join(__dirname, 'data');
const db = {
    users: [],
    servers: [],
    config: {},
    versions: []
};

const writeQueue = new Set();
let writeTimeout = null;

async function loadDb() {
    try {
        await fs.mkdir(dataDir, { recursive: true });

        const readWithDefault = async (file, defaultValue) => {
            try {
                const data = await fs.readFile(path.join(dataDir, file), 'utf-8');
                return JSON.parse(data);
            } catch (error) {
                if (error.code === 'ENOENT' || error instanceof SyntaxError) {
                    console.warn(`Could not read or parse ${file}, using default value.`);
                    return defaultValue;
                }
                throw error;
            }
        };

        db.config = await readWithDefault('config.json', {});
        db.users = await readWithDefault('users.json', []);
        db.servers = await readWithDefault('servers.json', []);
        db.versions = await readWithDefault('versions.json', []);

    } catch (error) {
        console.error("Fatal: Failed to load database from files:", error);
        process.exit(1);
    }
}

async function flushDb() {
    if (writeTimeout) {
        clearTimeout(writeTimeout);
        writeTimeout = null;
    }
    if (writeQueue.size === 0) return;

    const filesToWrite = [...writeQueue];
    writeQueue.clear();

    console.log(`Saving database changes to [${filesToWrite.join(', ')}]...`);

    for (const file of filesToWrite) {
        const dbName = file.replace('.json', '');
        const data = db[dbName];
        if (data) {
            try {
                const filePath = path.join(dataDir, file);
                await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
            } catch (error) {
                console.error(`Error writing to database file ${file}:`, error);
                // Re-add to queue to try again later
                writeQueue.add(file);
            }
        }
    }
}

// Helper function to read a JSON file from memory
async function readDb(file) {
    const dbName = file.replace('.json', '');
    // Return a deep copy to prevent accidental mutation of the in-memory db
    return JSON.parse(JSON.stringify(db[dbName]));
}

// Helper function to write to a JSON file in memory and schedule a disk write
async function writeDb(file, data) {
    const dbName = file.replace('.json', '');
    db[dbName] = data;
    writeQueue.add(file);

    if (writeTimeout) clearTimeout(writeTimeout);
    writeTimeout = setTimeout(flushDb, 3000); // Write after 3 seconds of the last change
}

// --- Caching Mechanism ---
const userCache = new Map(); // Cache for user status (banned, admin)
const subscriptionCache = new Map(); // Cache for channel subscription status

function getFromCache(cache, key) {
    const entry = cache.get(key);
    if (entry && entry.expiry > Date.now()) {
        return entry.value;
    }
    cache.delete(key); // Remove expired entry
    return null;
}

function setToCache(cache, key, value, ttl) { // ttl in seconds
    const expiry = Date.now() + ttl * 1000;
    cache.set(key, { value, expiry });
}
// --- End Caching Mechanism ---

async function checkUserSubscription(ctx, silent = false) {
    const userId = ctx.from.id;
    const cachedStatus = getFromCache(subscriptionCache, userId);
    if (cachedStatus !== null) {
        return cachedStatus;
    }

    const config = await readDb('config.json');
    const requiredChannels = config.requiredChannels || [];
    
    if (requiredChannels.length === 0) {
        setToCache(subscriptionCache, userId, true, 3600); // Cache for 1 hour if no channels
        return true;
    }

    const unsubscribed = [];

    for (const channel of requiredChannels) {
        try {
            const member = await ctx.telegram.getChatMember(channel, userId);
            if (['left', 'kicked'].includes(member.status)) {
                unsubscribed.push(channel);
            }
        } catch (err) {
            console.error(`فشل التحقق من القناة ${channel}:`, err.message);
            unsubscribed.push(channel);
        }
    }

    if (unsubscribed.length > 0) {
        if (!silent) {
            let msg = '🔔 عذرًا، يجب الاشتراك في القنوات التالية:\n\n';
            msg += unsubscribed.map(ch => `- ${ch}`).join('\n');
            msg += '\n\n➡️ بعد الاشتراك، اضغط:';

            try {
                await ctx.reply(msg, Markup.inlineKeyboard([
                    [Markup.button.callback('✅ لقد اشتركت، تحقق الآن', 'check_subscription')]
                ]));
            } catch (error) {
                if (error.code === 403) {
                    console.log(`Could not send subscription message to ${userId}: Bot was blocked.`);
                } else {
                    console.error(`Error sending subscription message to ${userId}:`, error);
                }
            }
        }
        
        setToCache(subscriptionCache, userId, false, 300); // Cache for 5 minutes
        return false;
    }
    
    setToCache(subscriptionCache, userId, true, 300); // Cache for 5 minutes
    return true;
}


const HOST = process.env.HOST || '0.0.0.0';
const PORT = process.env.PORT || 3001;
const BOT_TOKEN = '7970353637:AAEbfzLrVResHSEWX9QqwrAqXCKKHRbvD0I';
const ADMIN_ID =7735298810;


// --- Data Models (using JSON files) ---

const Users = {
    async find() {
        return await readDb('users.json');
    },
    async findOne(query) {
        const users = await this.find();
        return users.find(u => Object.keys(query).every(key => u[key] === query[key])) || null;
    },
    async create(userData) {
        const users = await this.find();
        const newUser = {
            ...userData,
            isBanned: false,
            isAdmin: userData.userId === ADMIN_ID,
            joinedAt: new Date().toISOString()
        };
        users.push(newUser);
        await writeDb('users.json', users);
        return newUser;
    },
    async updateOne(query, update) {
        let users = await this.find();
        const userIndex = users.findIndex(u => Object.keys(query).every(key => u[key] === query[key]));
        if (userIndex !== -1) {
            const operation = Object.keys(update)[0]; // $set, $addToSet etc.
            const payload = update[operation];
            users[userIndex] = { ...users[userIndex], ...payload };
            await writeDb('users.json', users);
        }
    },
    async countDocuments(query = {}) {
        const users = await this.find();
        if (Object.keys(query).length === 0) return users.length;
        return users.filter(u => Object.keys(query).every(key => u[key] === query[key])).length;
    }
};

const Servers = {
    async find(query = {}) {
        const servers = await readDb('servers.json');
        if (Object.keys(query).length === 0) return servers;
        return servers.filter(s => Object.keys(query).every(key => s[key] === query[key]));
    },
    async findById(id) {
        const servers = await this.find();
        return servers.find(s => s._id === id) || null;
    },
    async findOne(query) {
        const servers = await this.find();
        return servers.find(s => Object.keys(query).every(key => s[key] === query[key])) || null;
    },
    async create(serverData) {
        const servers = await this.find();
        const newServer = {
            _id: crypto.randomBytes(12).toString('hex'), // Generate a unique ID
            ...serverData,
            status: 'متوقف',
            notifyOnError: true,
            autoRestart: false,
            botName: 'X3k_BOT'
        };
        servers.push(newServer);
        await writeDb('servers.json', servers);
        return newServer;
    },
    async updateOne(query, update) {
        let servers = await this.find();
        const serverIndex = servers.findIndex(s => s._id === query._id);
        if (serverIndex !== -1) {
            const operation = Object.keys(update)[0]; // $set
            const payload = update[operation];
            servers[serverIndex] = { ...servers[serverIndex], ...payload };
            await writeDb('servers.json', servers);
        }
    },
    async deleteOne(query) {
        let servers = await this.find();
        const initialLength = servers.length;
        servers = servers.filter(s => !Object.keys(query).every(key => s[key] === query[key]));
        if (servers.length < initialLength) {
            await writeDb('servers.json', servers);
            return { deletedCount: 1 };
        }
        return { deletedCount: 0 };
    },
    async countDocuments(query = {}) {
        const servers = await this.find();
        if (Object.keys(query).length === 0) return servers.length;
        return servers.filter(s => Object.keys(query).every(key => s[key] === query[key])).length;
    }
};

const Config = {
    async findOne(query) {
        const config = await readDb('config.json');
        return { key: query.key, value: config[query.key] };
    },
    async updateOne(query, update, options = {}) {
        let config = await readDb('config.json');
        const key = query.key;
        if (update.$set) {
            config[key] = update.$set.value;
        } else if (update.$addToSet) {
            if (!config[key]) config[key] = [];
            const valueToAdd = update.$addToSet.value;
            if (!config[key].includes(valueToAdd)) {
                config[key].push(valueToAdd);
            }
        } else if (update.$pull) {
            if (config[key]) {
                config[key] = config[key].filter(item => item !== update.$pull.value);
            }
        } else if (update.$setOnInsert && options.upsert) {
            if (config[key] === undefined) {
                config[key] = update.$setOnInsert.value;
            }
        }
        await writeDb('config.json', config);
    }
};

const Versions = {
    async find(query = {}) {
        const versions = await readDb('versions.json');
        if (Object.keys(query).length === 0) return versions;
        return versions.filter(v => Object.keys(query).every(key => v[key] === query[key]));
    },
    async create(versionData) {
        let versions = await this.find();
        // Check for duplicates
        const exists = versions.some(v => v.protocol === versionData.protocol);
        if (exists) {
            const error = new Error('Duplicate key');
            error.code = 11000;
            throw error;
        }
        versions.push(versionData);
        await writeDb('versions.json', versions);
    },
    async deleteOne(query) {
        let versions = await this.find();
        const initialLength = versions.length;
        versions = versions.filter(v => !Object.keys(query).every(key => v[key] === query[key]));
        if (versions.length < initialLength) {
            await writeDb('versions.json', versions);
            return { deletedCount: 1 };
        }
        return { deletedCount: 0 };
    },
    async countDocuments() {
        const versions = await this.find();
        return versions.length;
    }
};


async function setupInitialConfig() {
    // Ensure data directory exists
    await fs.mkdir(dataDir, { recursive: true });

    // Set Admin
    let users = await readDb('users.json');
    let admin = users.find(u => u.userId === ADMIN_ID);
    if (admin) {
        if (!admin.isAdmin) {
            admin.isAdmin = true;
            await writeDb('users.json', users);
        }
    } else {
        users.push({ userId: ADMIN_ID, username: 'Admin', isBanned: false, isAdmin: true, joinedAt: new Date().toISOString() });
        await writeDb('users.json', users);
    }

    // Set default config
    let config = await readDb('config.json');
    const defaults = {
        botOnline: true,
        adminNotifications: false,
        requiredChannels: []
    };
    let configUpdated = false;
    for (const key in defaults) {
        if (config[key] === undefined) {
            config[key] = defaults[key];
            configUpdated = true;
        }
    }
    if (configUpdated) {
        await writeDb('config.json', config);
    }

    // Populate versions if empty
    const versionsCount = await Versions.countDocuments();
    if (versionsCount === 0) {
        console.log('Populating database with default Minecraft versions...');
        const BEDROCK_VERSIONS = { 818: '1.21.90', 800: '1.21.80', 786: '1.21.70', 776: '1.21.60', 766: '1.21.50', 748: '1.21.42', 729: '1.21.30', 712: '1.21.20', 686: '1.21.2', 685: '1.21.0', 671: '1.20.80', 662: '1.20.71', 649: '1.20.61', 630: '1.20.50', 622: '1.20.40', 618: '1.20.30', 594: '1.20.10', 589: '1.20.0', 582: '1.19.80', 575: '1.19.70', 568: '1.19.63', 560: '1.19.50', 554: '1.19.30', 544: '1.19.20', 527: '1.19.1', 503: '1.18.30', 475: '1.18.0', 448: '1.17.10', 422: '1.16.201' };

        const versionDocs = [];
        for (const protocol in BEDROCK_VERSIONS) {
            versionDocs.push({ type: 'bedrock', protocol: parseInt(protocol), name: BEDROCK_VERSIONS[protocol] });
        }
        await writeDb('versions.json', versionDocs);
        console.log('Default versions populated.');
    }
}

async function reorderServers(userId) {
    const servers = await Servers.find({ userId });
    servers.sort((a, b) => {
        if (a.createdAt && b.createdAt) {
            return new Date(a.createdAt) - new Date(b.createdAt);
        }
        return 0;
    });
    let expected = 1;
    for (const server of servers) {
        const newName = `S-${expected}`;
        if (server.serverName !== newName) {
            await Servers.updateOne(
                { _id: server._id },
                { $set: { serverName: newName } }
            );
        }
        expected++;
    }
}

async function getSupportedVersions() {
    const versions = await Versions.find();
    const protocolMap = { java: {}, bedrock: {} };
    versions.forEach(v => {
        protocolMap[v.type][v.protocol] = v.name;
    });
    return protocolMap;
}

async function startBot(ctx, serverId) {
    const server = await Servers.findById(serverId);
    if (!server) {
        try {
            await ctx?.editMessageText('❌ لم يتم العثور على السيرفر.');
        } catch (e) { /* ignore */ }
        return;
    }
    if (server.serverType === 'java') {
        try {
            await ctx?.editMessageText('❌ لم تعد سيرفرات جافا مدعومة.');
        } catch (e) { /* ignore */ }
        return;
    }

    if (server.botPid) {
        try {
            // Check if the process is actually running
            process.kill(server.botPid, 0);
            try {
                await ctx?.editMessageText('⚠️ البوت يعمل بالفعل على هذا السيرفر.');
            } catch (e) { /* ignore */ }
            return;
        } catch (e) {
            // Process not found, so we can start a new one
        }
    }


    await Servers.updateOne({ _id: server._id }, { $set: { status: 'جاري البحث...' } });
    try {
        await ctx?.editMessageText(`⏳ جاري البحث عن معلومات سيرفر ${server.serverType.toUpperCase()}...`);
    } catch (e) { /* ignore */ }

    const versions = await getSupportedVersions();
    const botFunctions = {
        bedrock: startBedrockBot,
    };
    botFunctions[server.serverType](ctx, server, versions);
}

async function startBedrockBot(ctx, server, versions) {
    try {
        const response = await statusBedrock(server.ip, server.port, { timeout: 8000 });
        const protocolVersion = response.version.protocol;
        const mcVersion = versions.bedrock[protocolVersion];

        if (!mcVersion) {
            await Servers.updateOne({ _id: server._id }, { $set: { status: 'إصدار غير مدعوم' } });
            try {
                await ctx?.editMessageText(`❌ إصدار بروتوكول البيدروك (${protocolVersion}) غير مدعوم حالياً.`);
            } catch (e) { /* ignore */ }
            return;
        }

        await Servers.updateOne({ _id: server._id }, { $set: { status: 'جاري التشغيل...' } });
        if (ctx) {
            try {
                await ctx.editMessageText(`✅ تم العثور على السيرفر (v${response.version.name}).\n⏳ جاري تشغيل البوت...`);
            } catch (e) { /* ignore */ }
        }

        const child = spawn('node', [
            path.join(__dirname, 'bedrock_client.js'),
            server.ip,
            server.port,
            server.botName,
            mcVersion
        ], {
            stdio: ['ignore', 'pipe', 'pipe'] // Pipe stdout and stderr
        });
        
        child.stdout.on('data', (data) => {
            console.log(`[${server.serverName}] ${data.toString().trim()}`);
        });

        child.stderr.on('data', (data) => {
            console.error(`[${server.serverName}] ${data.toString().trim()}`);
        });

        child.on('exit', (code, signal) => {
            console.log(`Bot process for server ${server.serverName} (PID: ${child.pid}) exited with code ${code}, signal ${signal}`);
            handleBotExit(server._id, ctx); 
        });
        
        child.on('error', (err) => {
            console.error(`Failed to start bot process for server ${server.serverName}: ${err.message}`);
            handleBotExit(server._id, ctx);
        });

        await Servers.updateOne({ _id: server._id }, { $set: { status: 'نشط', botPid: child.pid } });

        if (ctx) {
            try {
                await ctx.editMessageText(`✅ البوت نشط الآن على سيرفر ${server.serverName}`, { reply_markup: undefined });
            } catch(e) { /* ignore */ }

            setTimeout(async () => {
                try {
                    const updatedServer = await Servers.findById(server._id);
                    const menu = getManageServerMenu(updatedServer);
                    if (menu) {
                        await ctx.editMessageText(menu.text, menu.options);
                    }
                } catch(e) { /* ignore */ }
            }, 3000);
        }

    } catch (error) {
        console.error(`Bedrock connection error: ${error.message}`);
        await Servers.updateOne({ _id: server._id }, { $set: { status: 'فشل الاتصال', botPid: null } });
        try {
            await ctx?.editMessageText(
                `❌ فشل الاتصال بالسيرفر. يرجى التأكد أن السيرفر شغال وأن البيانات صحيحة.`
            );
        } catch (e) { /* ignore */ }
    }
}

async function handleBotExit(serverId, ctx) {
    const server = await Servers.findById(serverId);
    if (!server) return;

    if (server.status !== 'نشط') {
        console.log(`Bot for ${server.serverName} already handled or stopped.`);
        return;
    }

    console.log(`Handling exit for bot on server ${server.serverName}`);
    await Servers.updateOne({ _id: server._id }, { $set: { status: 'متوقف', botPid: null } });

    const owner = await Users.findOne({ userId: server.userId });

    if (owner && server.notifyOnError) {
        try {
            const message = `⚠️ انقطع اتصال البوت *${server.botName}* من سيرفر *${server.serverName}*.`;
            await bot.telegram.sendMessage(owner.userId, message, { parse_mode: 'Markdown' });
        } catch (e) {
            console.error(`Failed to send disconnect notification to user ${owner.userId}: ${e.message}`);
        }
    }

    if (server.autoRestart) {
        console.log(`Auto-restarting bot for server ${server.serverName}...`);
        if (owner) {
            try {
                const message = `🔄 جاري إعادة تشغيل البوت لسيرفر *${server.serverName}* تلقائياً...`;
                await bot.telegram.sendMessage(owner.userId, message, { parse_mode: 'Markdown' });
            } catch (e) {
                console.error(`Failed to send restart notification to user ${owner.userId}: ${e.message}`);
            }
        }
        setTimeout(() => {
            startBot(null, serverId);
        }, 5000);
    } else {
        if (ctx) {
            await manageServerAction(ctx, serverId).catch(e => console.error("Error updating menu after bot exit:", e.message));
        }
    }
}


async function manageServerAction(ctx, serverId) {
    const server = await Servers.findById(serverId);
    const menu = getManageServerMenu(server);

    if (menu) {
        try {
            await ctx.editMessageText(menu.text, menu.options);
        } catch (e) {
            if (!(e.response && e.response.description.includes('message is not modified'))) {
                 console.error("Error in manageServerAction:", e.message);
            }
        }
    } else {
        try {
            await ctx.editMessageText('❌ لم يتم العثور على السيرفر.');
        } catch (e) { /* ignore */ }
    }
}

async function stopBot(ctx, serverId) {
    const server = await Servers.findById(serverId);
    if (!server) {
        try {
            await ctx.editMessageText('❌ لم يتم العثور على السيرفر.');
        } catch (e) { /* ignore */ }
        return;
    }

    if (server.botPid) {
        try {
            process.kill(server.botPid, 'SIGTERM');
            console.log(`Sent SIGTERM to process ${server.botPid} for server ${server.serverName}`);
        } catch (e) {
            console.warn(`Could not kill process ${server.botPid}. It might have already been stopped. Error: ${e.message}`);
        }
    }

    await Servers.updateOne({ _id: server._id }, { $set: { status: 'متوقف', autoRestart: false, botPid: null } });

    try {
        await ctx.answerCbQuery('تم إيقاف البوت بنجاح.');
    } catch (e) { /* ignore */ }
    await manageServerAction(ctx, serverId);
}

function getManageServerMenu(server) {
    if (!server) return null;

    const statusIcon = server.status === 'نشط' ? '🟢' : (server.status === 'متوقف' ? '🔴' : '🟡');
    const text = `إدارة السيرفر: ${server.serverName}\n` + 
             `----------------------------------------\n` + 
             `🏷️ الاسم: ${server.serverName}\n` + 
             `🌐 الرابط: ${server.ip}:${server.port}\n` + 
             `🤖 اسم البوت: ${server.botName}\n` + 
             `📊 الحالة: ${statusIcon} ${server.status}`;

    const keyboard = Markup.inlineKeyboard([
        server.status === 'نشط'
            ? [Markup.button.callback('⏹ إيقاف البوت', `stop_bot:${server._id}`)]
            : [Markup.button.callback('▶️ تشغيل البوت', `start_bot:${server._id}`)],
        [
            Markup.button.callback('ℹ️ معلومات حية', `info_server:${server._id}`),
            Markup.button.callback('✏️ تغيير اسم البوت', `rename_bot:${server._id}`)
        ],
        
        [
            Markup.button.callback(`🔔 الإشعارات: ${server.notifyOnError ? 'مفعلة' : 'معطلة'}`, `toggle_notify:${server._id}`),
            Markup.button.callback(`🔄 التشغيل التلقائي: ${server.autoRestart ? 'مفعل' : 'معطل'}`, `toggle_autorestart:${server._id}`)
        ],
        [Markup.button.callback('🗑 حذف السيرفر', `delete_confirm:${server._id}`)],
        [Markup.button.callback('🔙 رجوع لسيرفراتي', 'my_servers')]
    ]);

    return { text, options: { ...keyboard } };
}

const addServerWizard = new Scenes.WizardScene(
    'add-server-wizard',
    async (ctx) => {
        ctx.wizard.state.messages = [];

        // السيرفر دائماً Bedrock
        ctx.wizard.state.serverData = { type: 'bedrock' };

        // توليد اسم تلقائي (S-1, S-2, ...)
        const userServers = await Servers.find({ userId: ctx.from.id });

        // استخرج الأرقام من أسماء السيرفرات S-1, S-2, ...
        const takenNumbers = userServers
            .map(s => {
                const match = s.serverName.match(/^S-(\d+)$/);
                return match ? parseInt(match[1]) : null;
            })
            .filter(n => n !== null);

        // إذا ماكو سيرفرات، يبدأ من 1
        let newNumber = 1;
        if (takenNumbers.length > 0) {
            newNumber = Math.max(...takenNumbers) + 1;  // دائماً بعد أكبر رقم
        }

        ctx.wizard.state.serverData.name = `S-${newNumber}`;

        try {
            const sentMessage = await ctx.reply(
                '📌 أرسل الآن الـ IP الخاص بالسيرفر (مثال: play.example.com)',
                Markup.inlineKeyboard([
                    [Markup.button.callback('❌ إلغاء والعودة للرئيسية', 'cancel_wizard')]
                ])
            );
            ctx.wizard.state.messages.push(sentMessage.message_id);
        } catch (e) {
            console.error("Error in add-server-wizard step (IP):", e.message);
        }

        // ننتقل مباشرة إلى خطوة إدخال الـ IP
        return ctx.wizard.selectStep(3);
    },
    async (ctx) => {
        if (ctx.callbackQuery?.data === 'cancel_wizard') {
            try { await ctx.deleteMessage(); } catch (e) {}
            try { await ctx.reply('تم إلغاء العملية.'); } catch (e) {}
            await ctx.scene.leave();
            return sendMainMenu(ctx);
        }

        // السيرفر دائماً Bedrock
        ctx.wizard.state.serverData = { type: 'bedrock' };

        // 🔄 هنا نستخدم نفس الكود الجديد
        const userServers = await Servers.find({ userId: ctx.from.id });

        const takenNumbers = userServers
            .map(s => {
                const match = s.serverName.match(/^S-(\d+)$/);
                return match ? parseInt(match[1]) : null;
            })
            .filter(n => n !== null);

        let newNumber = 1;
        if (takenNumbers.length > 0) {
            newNumber = Math.max(...takenNumbers) + 1;
        }

        ctx.wizard.state.serverData.name = `S-${newNumber}`;

        try { await ctx.deleteMessage(); } catch (e) {}

        // مباشرة يطلب الـ IP
        try {
            const sentMessage = await ctx.reply('📌 أرسل الآن الـ IP الخاص بالسيرفر (مثال: play.example.com)', 
                Markup.inlineKeyboard([
                    [Markup.button.callback('❌ إلغاء والعودة للرئيسية', 'cancel_wizard')]
                ])
            );
            ctx.wizard.state.messages.push(sentMessage.message_id);
        } catch (e) {
            console.error("Error in add-server-wizard step (IP):", e.message);
        }

        return ctx.wizard.selectStep(3); // تخطي خطوة "الاسم" والانتقال مباشرة للـ IP
    },
    async (ctx) => {
        if (ctx.callbackQuery?.data === 'cancel_wizard') {
             try {
                await ctx.deleteMessage();
             } catch (e) { /* ignore */ }
             try {
                await ctx.reply('تم إلغاء العملية.');
             } catch (e) { /* ignore */ }
             await ctx.scene.leave();
             return sendMainMenu(ctx);
        }
        if (!ctx.message?.text) return;

        if (!ctx.wizard.state.serverData) {
            try {
                await ctx.reply('حدث خطأ ما، لنبدأ من جديد.');
            } catch (e) { /* ignore */ }
            return ctx.scene.reenter();
        }

        ctx.wizard.state.serverData.name = ctx.message.text.trim();
        try {
            await ctx.deleteMessage(ctx.message.message_id);
            await ctx.deleteMessage(ctx.wizard.state.messages.pop());
        } catch (e) { /* ignore */ }
        try {
            const sentMessage = await ctx.reply('تم حفظ الاسم. الآن أرسل الـ IP أو رابط السيرفر.\n\n متال :(askozar.aternos.me)', Markup.inlineKeyboard([
                [Markup.button.callback('❌ إلغاء والعودة للرئيسية', 'cancel_wizard')]
            ]));
            ctx.wizard.state.messages.push(sentMessage.message_id);
        } catch (e) {
            console.error("Error in add-server-wizard step 3:", e.message);
        }
        return ctx.wizard.next();
    },
    async (ctx) => {
        if (ctx.callbackQuery?.data === 'cancel_wizard') {
             try {
                await ctx.deleteMessage();
             } catch (e) { /* ignore */ }
             try {
                await ctx.reply('تم إلغاء العملية.');
             } catch (e) { /* ignore */ }
             await ctx.scene.leave();
             return sendMainMenu(ctx);
        }
        if (!ctx.message?.text) return;
        ctx.wizard.state.serverData.ip = ctx.message.text.trim();
        try {
            await ctx.deleteMessage(ctx.message.message_id);
            await ctx.deleteMessage(ctx.wizard.state.messages.pop());
        } catch (e) { /* ignore */ }
        try {
            const sentMessage = await ctx.reply(' تم حفظ الـ IP. الآن أرسل رقم البورت (Port) :', Markup.inlineKeyboard([
                [Markup.button.callback('❌ إلغاء والعودة للرئيسية', 'cancel_wizard')] 
            ]));
            ctx.wizard.state.messages.push(sentMessage.message_id);
        } catch (e) {
            console.error("Error in add-server-wizard step 4:", e.message);
        }
        return ctx.wizard.next();
    },
    async (ctx) => {
    if (!ctx.message?.text) return;
    const port = parseInt(ctx.message.text.trim());
    ctx.wizard.state.serverData.port = port;

    if (isNaN(port) || port < 1 || port > 65535) {
        try {
            const sentMessage = await ctx.reply('رقم البورت غير صالح، ارسل الرقم الصحيح:');
            ctx.wizard.state.messages.push(ctx.message.message_id, sentMessage.message_id);
        } catch (e) { /* ignore */ }
        return;
    }

    try {
        await ctx.deleteMessage(ctx.message.message_id);
        await ctx.deleteMessage(ctx.wizard.state.messages.pop());
    } catch (e) { /* ignore */ }

    try {
        const serverCount = await Servers.countDocuments({ userId: ctx.from.id });
        if (serverCount >= 3) {
            await ctx.editMessageText('❌ لا يمكنك إضافة أكثر من 3 سيرفرات.', Markup.inlineKeyboard([
                [Markup.button.callback('🔙 رجوع إلى القائمة الرئيسية', 'main_menu')]
            ]));
            return ctx.scene.leave();
        }

        const duplicateOwn = await Servers.findOne({
            ip: ctx.wizard.state.serverData.ip,
            port: ctx.wizard.state.serverData.port,
            userId: ctx.from.id
        });
        if (duplicateOwn) {
            await ctx.reply('⚠️ لقد قمت بإضافة هذا السيرفر مسبقاً.');
            await ctx.scene.leave();
            return sendMainMenu(ctx);
        }

        const duplicateOther = await Servers.findOne({
        ip: ctx.wizard.state.serverData.ip,
        port: ctx.wizard.state.serverData.port,
    });

if (duplicateOther) {
    await ctx.scene.leave();
    try {
        await ctx.reply(
            `❌ هذا السيرفر مضاف بالفعل من قبل مستخدم آخر.\n\n🌐 ${ctx.wizard.state.serverData.ip}:${ctx.wizard.state.serverData.port}`,
            Markup.inlineKeyboard([
                [Markup.button.callback('🔙 رجوع إلى القائمة الرئيسية', 'main_menu')]
            ])
        );
    } catch (e) { /* ignore */ }
    return;
}

        const newServer = await Servers.create({
        userId: ctx.from.id,
        serverName: ctx.wizard.state.serverData.name,
        serverType: ctx.wizard.state.serverData.type,
        ip: ctx.wizard.state.serverData.ip,
        port: ctx.wizard.state.serverData.port
  });

// ✨ إعادة ترتيب السيرفرات بعد الإضافة
await reorderServers(ctx.from.id);

        await ctx.scene.leave();

        const successMsg = await ctx.reply(`✅ تم إضافة السيرفر "${newServer.serverName}"`);

        setTimeout(async () => {
            try {
                await ctx.deleteMessage(successMsg.message_id);
                const menu = getManageServerMenu(newServer);
                if (menu) {
                    await ctx.reply(menu.text, menu.options);
                }
            } catch (e) { /* ignore */ }
        }, 3000);

    } catch (error) {
        console.error('خطأ أثناء إضافة السيرفر:', error.message);
        try {
            await ctx.reply('حدث خطأ أثناء حفظ السيرفر. إذا استمرت المشكلة، تواصل مع المطور: @TP_JN');
        } catch (e) { /* ignore */ }
        await ctx.scene.leave();
       }
   }
);

addServerWizard.action('cancel_wizard', async (ctx) => {
    try {
        await ctx.deleteMessage();
        await ctx.reply('تم إلغاء العملية.');
    } catch (e) { /* ignore */ }
    await ctx.scene.leave();
    return sendMainMenu(ctx);
});

const renameBotScene = new Scenes.BaseScene('rename-bot-scene');
renameBotScene.enter(async (ctx) => {
    try {
        ctx.scene.state.serverId = ctx.match[1];
        const prompt = await ctx.editMessageText('.إحدر ان تضيف مسفات في الإسم\n.الإسم يجب ان يكون بي الإنجليزية فقط\n\nأرسل الإسم الجديد لي البوت: \n(اضغط /cancel لي إلغاء العملية)', { reply_markup: undefined });
        ctx.scene.state.messageToEdit = prompt.message_id;
    } catch (e) {
        console.error("Error entering rename scene:", e);
        try {
            await ctx.reply("حدث خطأ، يرجى المحاولة مرة أخرى.");
        } catch (e) { /* ignore */ }
        await ctx.scene.leave();
    }
});

renameBotScene.on('text', async (ctx) => {
    try {
        await ctx.deleteMessage(ctx.message.id);
    } catch (e) { /* ignore */ }
    const messageToEdit = ctx.scene.state.messageToEdit;

    if (!messageToEdit) {
        try {
            await ctx.reply("انتهت صلاحية هذه الجلسة، يرجى المحاولة من جديد.");
        } catch (e) { /* ignore */ }
        return ctx.scene.leave();
    }
    
    if (ctx.message.text === '/cancel') {
        try {
            await ctx.telegram.editMessageText(ctx.chat.id, messageToEdit, undefined, 'تم إلغاء العملية.');
            setTimeout(() => ctx.deleteMessage(messageToEdit).catch(() => {}), 3000);
        } catch (e) { /* ignore */ }
        return ctx.scene.leave();
    }

    const newName = ctx.message.text.trim();
    const serverId = ctx.scene.state.serverId;
    await Servers.updateOne({ _id: serverId }, { $set: { botName: newName } });
    await ctx.scene.leave();

    try {
        await ctx.telegram.editMessageText(ctx.chat.id, messageToEdit, undefined, `✅ تم تغيير اسم البوت إلى "${newName}".`);
    } catch (e) { /* ignore */ }

    setTimeout(async () => {
        try {
            const updatedServer = await Servers.findById(serverId);
            const menu = getManageServerMenu(updatedServer);
            if (menu) {
                await ctx.telegram.editMessageText(ctx.chat.id, messageToEdit, undefined, menu.text, menu.options);
            }
        } catch (e) { /* ignore */ }
    }, 3000);
});
const addChannelScene = new Scenes.BaseScene('admin-add-channel-scene');
addChannelScene.enter((ctx) => ctx.reply('أرسل اسم القناة مع @ (مثال: @X3k_w)\nللإلغاء أرسل /cancel 👇').catch(console.error));
addChannelScene.on('text', async (ctx) => {
    if (ctx.message.text === '/cancel') {
        await ctx.scene.leave();
        return ctx.reply('تم إلغاء العملية.').catch(console.error);
    }
    const channelName = ctx.message.text.trim();
    if (!channelName.startsWith('@')) {
        return ctx.reply('صيغة غير صحيحة. يجب أن يبدأ يوزر القناة بي @').catch(console.error);
    }

    await Config.updateOne(
        { key: 'requiredChannels' },
        { $addToSet: { value: channelName } }, 
        { upsert: true }
    );
    subscriptionCache.clear(); // Invalidate cache
    await ctx.reply(`✅ تم إضافة القناة ${channelName}.\nℹ️ سيتم التحقق من اشتراك جميع المستخدمين مرة أخرى.`).catch(console.error);
    await ctx.scene.leave();
    ctx.update.callback_query = { data: 'admin_channels' };
    await bot.handleUpdate(ctx.update);
});
const removeChannelScene = new Scenes.BaseScene('admin-remove-channel-scene');
removeChannelScene.enter((ctx) => ctx.reply('أرسل اسم القناة التي تريد حذفها. مع @ \nللإلغاء أرسل /cancel').catch(console.error));
removeChannelScene.on('text', async (ctx) => {
    if (ctx.message.text === '/cancel') {
        await ctx.scene.leave();
        return ctx.reply('تم إلغاء العملية.').catch(console.error);
    }
    const channelName = ctx.message.text.trim();

    await Config.updateOne(
        { key: 'requiredChannels' },
        { $pull: { value: channelName } } 
    );
    subscriptionCache.clear(); // Invalidate cache
    await ctx.reply(`✅ تم حذف القناة ${channelName}.\nℹ️ سيتم التحقق من اشتراك جميع المستخدمين مرة أخرى.`).catch(console.error);
    
    await ctx.scene.leave();
    ctx.update.callback_query = { data: 'admin_channels' };
    await bot.handleUpdate(ctx.update);
});
async function showAllServers(ctx, page = 1) {
    const PAGE_SIZE = 8; 
    try {
        await ctx.answerCbQuery();
    } catch (e) { /* ignore */ }

    const allServers = await Servers.find();
    const totalServers = allServers.length;
    const totalPages = Math.ceil(totalServers / PAGE_SIZE);
    if (page < 1) page = 1;
    if (page > totalPages) page = totalPages;

    const servers = allServers
        .sort((a, b) => (a._id < b._id ? 1 : -1)) // Sort descending by ID
        .slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

    if (totalServers === 0) {
        try {
            await ctx.editMessageText('لا توجد أي سيرفرات مسجلة في البوت حالياً.', Markup.inlineKeyboard([
                [Markup.button.callback('🔙 رجوع', 'admin_panel')]
            ]));
        } catch (e) { /* ignore */ }
        return;
    }

    let message = `🖥️ عرض جميع السيرفرات (صفحة ${page} من ${totalPages})\n\n`;
    for (const server of servers) {
        const owner = await Users.findOne({ userId: server.userId });
        const ownerUsername = owner ? (owner.username || `ID: ${owner.userId}`) : 'غير معروف';
        message += `🗿${server.serverName} (${server.ip}:${server.port})
`;
        message += `   - مالك السيرفر: ${ownerUsername}
`;
        message += `   - نوعه: ${server.serverType}\n`;
        message += `
`;
    }

    const navigationButtons = [];
    if (page > 1) {
        navigationButtons.push(Markup.button.callback('◀️ السابق', `admin_all_servers:${page - 1}`));
    }
    if (page < totalPages) {
        navigationButtons.push(Markup.button.callback('التالي ▶️', `admin_all_servers:${page + 1}`));
    }

    const keyboard = Markup.inlineKeyboard([
        navigationButtons,
        [Markup.button.callback('🔙 رجوع إلى لوحة التحكم', 'admin_panel')]
    ]);

    try {
        await ctx.editMessageText(message, { ...keyboard });
    } catch (e) { /* ignore */ }
}


// --- بث مع خيار تثبيت الرسالة ---
const broadcastWizard = new Scenes.WizardScene(
  'admin-broadcast-wizard',
  async (ctx) => {
    // الخطوة 1: أخذ الرسالة
    try {
      ctx.wizard.state.broadcast = { pin: false };
      await ctx.reply(
        'أرسل الرسالة التي تريد إذاعتها للجميع.\nللإلغاء أرسل /cancel'
      );
      return ctx.wizard.next();
    } catch (e) { console.error(e); }
  },
  async (ctx) => {
    // استلام الرسالة المطلوب بثها
    if (ctx.message?.text === '/cancel') {
      await ctx.scene.leave();
      return ctx.reply('تم إلغاء الإذاعة.').catch(console.error);
    }

    ctx.wizard.state.broadcast.sourceChatId = ctx.chat.id;
    ctx.wizard.state.broadcast.sourceMessageId = ctx.message.message_id;

    const pin = ctx.wizard.state.broadcast.pin;
    const btnText = pin ? '📌 التثبيت: مفعّل' : '📌 التثبيت: معطّل';

    try {
      await ctx.reply(
        'اختر إعدادات الإذاعة ثم اضغط "🚀 إرسال":',
        Markup.inlineKeyboard([
          [Markup.button.callback(btnText, 'toggle_pin')],
          [Markup.button.callback('🚀 إرسال', 'broadcast_send')],
          [Markup.button.callback('❌ إلغاء', 'broadcast_cancel')],
        ])
      );
    } catch (e) { console.error(e); }
  }
);

// أزرار الخيارات
broadcastWizard.action('toggle_pin', async (ctx) => {
  try { await ctx.answerCbQuery(); } catch(e) {}
  ctx.wizard.state.broadcast.pin = !ctx.wizard.state.broadcast.pin;
  const pin = ctx.wizard.state.broadcast.pin;
  const btnText = pin ? '📌 التثبيت: مفعّل' : '📌 التثبيت: معطّل';

  try {
    await ctx.editMessageReplyMarkup(
      Markup.inlineKeyboard([
        [Markup.button.callback(btnText, 'toggle_pin')],
        [Markup.button.callback('🚀 إرسال', 'broadcast_send')],
        [Markup.button.callback('❌ إلغاء', 'broadcast_cancel')],
      ]).reply_markup
    );
  } catch (e) { console.error(e); }
});

broadcastWizard.action('broadcast_cancel', async (ctx) => {
  try { await ctx.answerCbQuery('تم الإلغاء'); } catch(e) {}
  await ctx.scene.leave();
  try { await ctx.editMessageText('تم إلغاء الإذاعة.'); } catch(e) {}
});

broadcastWizard.action('broadcast_send', async (ctx) => {
  try { await ctx.answerCbQuery('جاري الإرسال...'); } catch(e) {}

  const { sourceChatId, sourceMessageId, pin } = ctx.wizard.state.broadcast || {};
  if (!sourceChatId || !sourceMessageId) {
    await ctx.scene.leave();
    return ctx.reply('❌ حدث خطأ: لا توجد رسالة للبث.').catch(console.error);
  }

  await ctx.scene.leave();
  await ctx.reply('جاري إرسال الإذاعة...').catch(console.error);

  const users = await Users.find({ isBanned: false });
  let successCount = 0, failureCount = 0, pinSuccess = 0, pinFail = 0;

  for (const user of users) {
    try {
      const sent = await ctx.telegram.copyMessage(
        user.userId,
        sourceChatId,
        sourceMessageId
      );
      successCount++;

      if (pin && sent && sent.message_id) {
        try {
          await ctx.telegram.pinChatMessage(user.userId, sent.message_id, {
            disable_notification: true
          });
          pinSuccess++;
        } catch (e) {
          pinFail++;
        }
      }
    } catch (e) {
      failureCount++;
    }
    await new Promise(r => setTimeout(r, 100));
  }

  let result = `✅ تمت الإذاعة.\n\n✅ أُرسلت إلى: ${successCount}\n❌ فشل: ${failureCount}`;
  if (pin) {
    result += `\n\n📌 التثبيت:\n- تم التثبيت: ${pinSuccess}\n- فشل التثبيت: ${pinFail}`;
  }
  await ctx.reply(result).catch(console.error);
});

const userActionScene = new Scenes.BaseScene('admin-user-action-scene');
userActionScene.enter((ctx) => {
    const action = ctx.match[1];
    const actionText = { 'ban': 'لحظر المستخدم', 'unban': 'لرفع الحظر', 'info': 'لعرض معلوماته' };
    ctx.scene.state.action = action;
    ctx.reply(`أرسل ID المستخدم ${actionText[action]}\nللإلغاء أرسل /cancel`).catch(console.error);
});
userActionScene.on('text', async (ctx) => {
    if (ctx.message.text === '/cancel') {
        await ctx.scene.leave();
        return ctx.reply('تم إلغاء العملية.').catch(console.error);
    }
    const targetId = parseInt(ctx.message.text.trim());
    if (isNaN(targetId)) return ctx.reply('ID غير صالح.').catch(console.error);
    if (targetId === ADMIN_ID) return ctx.reply('لا يمكن تطبيق هذا الإجراء على المطور الأساسي.').catch(console.error);
    const user = await Users.findOne({ userId: targetId });
    if (!user) return ctx.reply('مستخدم غير موجود.').catch(console.error);
    const action = ctx.scene.state.action;
    switch (action) {
        case 'ban':
            await Users.updateOne({ userId: targetId }, { $set: { isBanned: true } });
            await ctx.reply(`✅ تم حظر المستخدم ${user.username || targetId}.`).catch(console.error);
            break;
        case 'unban':
            await Users.updateOne({ userId: targetId }, { $set: { isBanned: false } });
            await ctx.reply(`✅ تم رفع الحظر عن ${user.username || targetId}.`).catch(console.error);
            break;
        case 'info':
    const serverCount = await Servers.countDocuments({ userId: targetId });

    // صياغة التاريخ بشكل أوضح
    const joinedDate = new Date(user.joinedAt).toLocaleString('en-GB', { 
            timeZone: 'Asia/Baghdad',
            hour12: false
     });

    // المعلومات مع الإيموجيات
    let info = `👤 *معلومات المستخدم:*\n\n` + 
           `🆔 User ID: \`${user.userId}\`\n` + 
           `📛 Username: ${user.username || 'غير معروف'}\n` + 
           `📛 Name: ${user.name || 'غير معروف'}\n` + 
           `👑 Admin: ${user.isAdmin ? '✅ Yes' : '❌ No'}\n` + 
           `🚫 Banned: ${user.isBanned ? '✅ Yes' : '❌ No'}\n` + 
           `📅 Joined: ${joinedDate}\n` + 
           `🖥 Servers: ${serverCount}`;

    // أزرار الإدارة
    const keyboard = Markup.inlineKeyboard([
                [Markup.button.callback('🗑 حذف جميع السيرفرات', `delete_all_servers:${targetId}`)],
                [Markup.button.callback('🔙 رجوع', 'admin_users')]
            ]);

            await ctx.reply(info, { parse_mode: 'Markdown', ...keyboard });
            break;
    }
    await ctx.scene.leave();
});

const adminActionScene = new Scenes.BaseScene('admin-action-scene');
adminActionScene.enter((ctx) => {
    const action = ctx.match[1];
    const actionText = { 'add': 'لإضافته كمسؤول', 'remove': 'لإزالته من المسؤولين' };
    ctx.scene.state.action = action;
    ctx.reply(`أرسل ID المستخدم ${actionText[action]}\nللإلغاء أرسل /cancel`).catch(console.error);
});
adminActionScene.on('text', async (ctx) => {
    if (ctx.message.text === '/cancel') {
        await ctx.scene.leave();
        return ctx.reply('تم إلغاء العملية.').catch(console.error);
    }
    const targetId = parseInt(ctx.message.text.trim());
    if (isNaN(targetId)) return ctx.reply('ID غير صالح.').catch(console.error);
    if (targetId === ADMIN_ID) return ctx.reply('لا يمكن تغيير صلاحيات المطور الأساسي.').catch(console.error);
    const user = await Users.findOne({ userId: targetId });
    if (!user) return ctx.reply('يجب على المستخدم أن يبدأ البوت أولاً.').catch(console.error);
    const action = ctx.scene.state.action;
    if (action === 'add') {
        await Users.updateOne({ userId: targetId }, { $set: { isAdmin: true } });
        await ctx.reply(`✅ تم ترقية ${user.username || targetId} إلى مسؤول.`).catch(console.error);
        await bot.telegram.sendMessage(targetId, '🎉 تهانينا! لقد تمت ترقيتك إلى مسؤول في البوت.').catch(()=>{});
    } else if (action === 'remove') {
        await Users.updateOne({ userId: targetId }, { $set: { isAdmin: false } });
        await ctx.reply(`✅ تم إزالة صلاحيات المسؤول من ${user.username || targetId}.`).catch(console.error);
    }
    await ctx.scene.leave();
});

const addVersionScene = new Scenes.WizardScene('admin-add-version-wizard',
    async (ctx) => {
        try {
            await ctx.reply('❓ هل أنت متأكد من إضافة الإصدار؟', Markup.inlineKeyboard([
               [Markup.button.callback("✅ نعم أضف", "version_type:bedrock")],
               [Markup.button.callback('❌ إلغاء', 'cancel_wizard')]
      ]));
        } catch (e) { /* ignore */ }
        return ctx.wizard.next();
    },
    async (ctx) => {
        if (ctx.callbackQuery?.data === 'cancel_wizard') { try { await ctx.deleteMessage(); await ctx.reply('تم الإلغاء.'); } catch (e) { /* ignore */ } return ctx.scene.leave(); }
        const type = ctx.callbackQuery.data.split(':')[1];
        ctx.wizard.state.versionData = { type };
        try {
            await ctx.deleteMessage();
            await ctx.reply(`أرسل اسم الإصدار (مثال: 1.21.1).`);
        } catch (e) { /* ignore */ }
        return ctx.wizard.next();
    },
    async (ctx) => {
        ctx.wizard.state.versionData.name = ctx.message.text.trim();
        try {
            await ctx.reply(`أرسل رقم البروتوكول الخاص به.`);
        } catch (e) { /* ignore */ }
        return ctx.wizard.next();
    },
    async (ctx) => {
        const protocol = parseInt(ctx.message.text.trim());
        if (isNaN(protocol)) {
            try {
                await ctx.reply('رقم البروتوكول يجب أن يكون رقماً.');
            } catch (e) { /* ignore */ }
            return;
        }
        ctx.wizard.state.versionData.protocol = protocol;
        try {
            await Versions.create(ctx.wizard.state.versionData);
            await ctx.reply(`✅ تم إضافة الإصدار بنجاح!`);
        } catch (e) {
            try {
                await ctx.reply(e.code === 11000 ? '❌ خطأ: البروتوكول موجود بالفعل.' : '❌ خطأ غير متوقع.');
            } catch (e) { /* ignore */ }
        }
        return ctx.scene.leave();
    }
);
addVersionScene.action('cancel_wizard', async (ctx) => {
    try {
        await ctx.deleteMessage();
        await ctx.reply('تم إلغاء العملية.');
    } catch (e) { /* ignore */ }
    return ctx.scene.leave();
});

const deleteVersionScene = new Scenes.BaseScene('admin-delete-version-scene');
deleteVersionScene.enter((ctx) => ctx.reply('أرسل رقم البروتوكول للإصدار الذي تريد حذفه.\nللإلغاء أرسل /cancel').catch(console.error));
deleteVersionScene.on('text', async (ctx) => {
    if (ctx.message.text === '/cancel') {
        await ctx.scene.leave();
        return ctx.reply('تم إلغاء العملية.').catch(console.error);
    }
    const protocol = parseInt(ctx.message.text.trim());
    if (isNaN(protocol)) return ctx.reply('رقم البروتوكول يجب أن يكون رقماً.').catch(console.error);
    const result = await Versions.deleteOne({ protocol: protocol });
    await ctx.reply(result.deletedCount > 0 ? '✅ تم حذف الإصدار.' : '❌ لم يتم العثور على إصدار بهذا الرقم.').catch(console.error);
    await ctx.scene.leave();
});


const stage = new Scenes.Stage([
  addServerWizard,
  renameBotScene,
  broadcastWizard, // ← الجديد
  userActionScene,
  adminActionScene,
  addVersionScene,
  deleteVersionScene,
  addChannelScene,
  removeChannelScene
]);

const bot = new Telegraf("7970353637:AAEbfzLrVResHSEWX9QqwrAqXCKKHRbvD0I");

bot.catch((err, ctx) => {
    if (err.response && err.response.error_code === 400) {
        const desc = err.response.description.toLowerCase();
        if (desc.includes('message is not modified') || desc.includes('query is too old')) {
            return; // Safe to ignore
        }
        if (desc.includes('message to edit not found')) {
            console.log('Attempted to edit a message that was not found. Ignoring.');
            try {
                // Attempt to answer the callback query to prevent the user's client from hanging
                if (ctx.callbackQuery) {
                    ctx.answerCbQuery('This message has expired. Please try again from the main menu.', { show_alert: true }).catch(() => {});
                }
            } catch (e) { /* ignore */ }
            return;
        }
    }

    if (err.name === 'TimeoutError') {
         console.error(`Timeout error for ${ctx.updateType}:`, err.message);
         return;
    }

    console.error(`Unhandled error for ${ctx.updateType}`, err);
});

bot.use(session());
bot.use(stage.middleware());

bot.use(async (ctx, next) => {
    if (!ctx.from) return next();

    const userId = ctx.from.id;
    // تحقق من اليوزر إذا موجود، إذا ماكو نخزن غير معروف
    let currentUsername = ctx.from.username ? `@${ctx.from.username}` : "غير معروف";

    // تحقق من الاسم إذا موجود، إذا ماكو نخزن غير معروف
    let currentName = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ');
    if (!currentName) currentName = "غير معروف";

    let user = await Users.findOne({ userId });
    if (user) {
        let updateNeeded = false;
        const updateData = {};

        // إذا تغير اليوزر
        if (user.username !== currentUsername) {
            updateData.username = currentUsername;
            updateNeeded = true;
        }
        // إذا تغير الاسم
        if (user.name !== currentName) {
            updateData.name = currentName;
            updateNeeded = true;
        }

        if (updateNeeded) {
            await Users.updateOne({ userId }, { $set: updateData });
            console.log(`✅ تم تحديث بيانات المستخدم ${userId}`);
        }
    } else {
        // إذا المستخدم جديد
        await Users.create({
            userId,
            username: currentUsername,
            name: currentName
        });
        console.log(`🆕 مستخدم جديد ${userId}`);
    }

    return next();
});


bot.use(async (ctx, next) => {
    if (ctx.chat?.type !== 'private') return;
    if (!ctx.from) return;

    const config = await readDb('config.json');
    if (config.botOnline === false && ctx.from.id !== ADMIN_ID) {
        try {
            await ctx.reply('⚠️ البوت تحت الصيانة حالياً.');
        } catch (e) { /* ignore */ }
        return;
    }

    const userId = ctx.from.id;
    let userStatus = getFromCache(userCache, userId);

    if (!userStatus) {
        const user = await Users.findOne({ userId: userId });
        if (user) {
            userStatus = { isBanned: user.isBanned, isAdmin: user.isAdmin };
            setToCache(userCache, userId, userStatus, 300); // Cache for 5 minutes 
        }
    }

    if (userStatus && userStatus.isBanned) {
        try {
            await ctx.reply('❌ أنت محظور من استخدام هذا البوت.');
        } catch (e) { /* ignore */ }
        return;
    }
    
    if (userStatus) {
        ctx.state.isAdmin = userStatus.isAdmin;
    }

    return next();
});

// 🛡️ فلتر يمنع غير الأدمن من استخدام أزرار لوحة الأدمن
bot.use(async (ctx, next) => {
    if (!ctx.callbackQuery) return next();

    // ✅ جميع الأوامر والأزرار الخاصة بالأدمن
    const adminOnlyActions = [
        // لوحة الأدمن الرئيسية
        'admin_panel', 'admin_stats', 'admin_broadcast', 'admin_users',
        'admin_all_servers', 'admin_versions', 'admin_manage_admins',
        'admin_system', 'admin_settings', 'admin_channels',

        // أوامر القنوات
        'admin_add_channel', 'admin_remove_channel',

        // أوامر المستخدمين
        'user_action:', 'delete_all_servers:',

        // أوامر الإصدارات
        'version_type', 'cancel_wizard', 'admin-add-version',
        'admin-delete-version',

        // أوامر المسؤولين
        'admin-action:',

        // أي زر يبدأ بـ admin_
        'admin_'
    ];

    const data = ctx.callbackQuery.data;

    if (adminOnlyActions.some(action => data.startsWith(action))) {
        const user = await Users.findOne({ userId: ctx.from.id });
        if (!user?.isAdmin) {
            try {
                await ctx.answerCbQuery('❌ هذا الزر خاص بالأدمن فقط.', { show_alert: true });
            } catch (e) { /* ignore */ }
            return; // 🚫 وقف التنفيذ
        }
    }

    return next();
});

bot.action('how_to_use', async (ctx) => {
    const usageText = `📚 *طريقة إضافة سيرفر:*

` +
                     `1. اضغط على "➕ إضافة سيرفر"
` +
                     `2. أرسل IP السيرفر (مثال: play.example.com)
` +
                     `3. أرسل بورت السيرفر (مثال: 19132)

` +
                     `4. تأكد انك مفعل ميزة المكركة في السيرفر

` +
                     `🔹 *ملاحظات مهمة:*
` +
                     `- يجب أن يكون السيرفر شغالاً عند إضافته
` +
                     `- تأكد من صحة البيانات المدخلة
` +
                     `- الحد الأقصى 3 سيرفرات لكل مستخدم

` +
                     `📌 *للمساعدة التقنية تفضل معنا في الجروب:*
` +
                     `@X3k_Q`;

    const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('🔙 رجوع', 'main_menu')]
    ]);

    try {
        if (ctx.callbackQuery) {
            await ctx.editMessageText(usageText, { ...keyboard });
        } else {
            await ctx.reply(usageText, { ...keyboard });
        }
    } catch (e) {
        console.error("Error sending usage instructions:", e.message);
    }
});


bot.start(async (ctx) => {
    try {
        subscriptionCache.delete(ctx.from.id);

        let user = await Users.findOne({ userId: ctx.from.id });
        if (!user) {
            user = await Users.create({
                userId: ctx.from.id,
                username: ctx.from.username || ctx.from.first_name,
            });
        }

        const isSubscribed = await checkUserSubscription(ctx);
        if (isSubscribed) {
            await sendMainMenu(ctx);
        }
    } catch (error) {
        console.error('Error in bot.start:', error);
        try {
            await ctx.reply('حدث خطأ ما، يرجى المحاولة مرة أخرى لاحقاً.');
        } catch (e) { /* ignore */ }
    }
});

bot.action('check_subscription', async (ctx) => {
    try {
        if (!ctx.callbackQuery) return;

        await ctx.answerCbQuery('جاري التحقق...');

        subscriptionCache.delete(ctx.from.id);

        const isSubscribed = await checkUserSubscription(ctx);
        if (isSubscribed) {
            await ctx.deleteMessage().catch(()=>{});
            await ctx.reply('🎉 شكراً لاشتراكك! يمكنك  الآن استخدام البوت اضغط • /start . ').catch(()=>{});
            await sendMainMenu(ctx);
        } else {
            await ctx.answerCbQuery('❌ ما زلت غير مشترك في كل القنوات.', { show_alert: false }).catch(()=>{});
        }
    } catch (error) {
        console.error("Error in subscription check:", error);
    }
});


bot.use(async (ctx, next) => {
    if (!ctx.from) return;

    // استثناء: المطور و الأدمن يتجاوزون الاشتراك
    if (ctx.state.isAdmin || ctx.from.id === ADMIN_ID) {
        return next();
    }

    // السماح فقط بـ /start و زر تحقق الاشتراك
    if (ctx.message?.text === '/start' || ctx.callbackQuery?.data === 'check_subscription') {
        return next();
    }

    // تحقق من الاشتراك لكل شيء آخر (زر أو رسالة)
    const isSubscribed = await checkUserSubscription(ctx, false);

    if (!isSubscribed) {
        // إذا مو مشترك يوقف فوراً
        if (ctx.callbackQuery) {
            await ctx.answerCbQuery('❌ اشترك أولاً بالقنوات!', { show_alert: true }).catch(() => {});
        }
        return; 
    }

    return next();
});


bot.command('cancel', async (ctx) => {
    await ctx.scene.leave();
    try {
        await ctx.reply('تم إلغاء العملية الحالية.');
    } catch (e) { /* ignore */ }
    await sendMainMenu(ctx);
});


async function sendMainMenu(ctx) {
    const fullName = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ');
    const text = `أهلاً بك ${fullName} في بوت بلاير 🌕\n` + 
                 `عملي هوا ابقاء السيرفر الخاص بك في\n` + 
                 `ماين كرافت شغال بدون توقف 24/7 🛎\n\n` + 
                 `اختر ما تريد من القائمة:`;

    const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('🎮 سيرفراتي', 'my_servers'), Markup.button.callback('➕ إضافة سيرفر', 'add_server_wizard')],
        [Markup.button.callback('❓ طريقة الإستخدام', 'how_to_use')],
        ...(ctx.state.isAdmin || ctx.from.id === ADMIN_ID) ? [[Markup.button.callback('👑 لوحة تحكم الأدمن', 'admin_panel')]] : [],
    ]);

    try {
        if (ctx.callbackQuery) {
            await ctx.editMessageText(text, { ...keyboard });
        } else {
            await ctx.reply(text, { ...keyboard });
        }
    } catch (e) {
        if (e.response && e.response.description.includes('message to edit not found')) {
            try {
                await ctx.reply(text, { ...keyboard });
            } catch (replyError) {
                console.error("Error sending main menu as a reply after edit failed:", replyError.message);
            }
        } else if (!(e.response && e.response.description.includes('message is not modified'))) {
            console.error("Error sending main menu:", e.message);
        }
    }
}

bot.action('main_menu', sendMainMenu);
bot.action('add_server_wizard', async (ctx) => {
    try {
        const count = await Servers.countDocuments({ userId: ctx.from.id });

        if (count >= 3) {
            return ctx.answerCbQuery(
                '❌ لا يمكنك إضافة أكثر من 3 سيرفرات.\nيرجى حذف سيرفر قبل إضافة جديد.',
                { show_alert: true }
            ).catch(()=>{});
        }

        return ctx.scene.enter('add-server-wizard');
    } catch (error) {
        console.error('Error in add_server_wizard:', error);
    }
});

async function showMyServers(ctx, message) {
    const allServers = await Servers.find({ userId: ctx.from.id });
    const servers = allServers
        .filter(s => s.serverType === 'bedrock')
        .sort((a, b) => {
            const numA = parseInt(a.serverName.replace('S-', '')) || 0;
            const numB = parseInt(b.serverName.replace('S-', '')) || 0;
            return numA - numB; // ترتيب تصاعدي S-1 ثم S-2 ثم S-3
        });

    if (servers.length === 0) {
        try {
            await ctx.editMessageText('ليس لديك أي سيرفرات بيدروك مضافة.', Markup.inlineKeyboard([
                [Markup.button.callback('➕ إضافة سيرفر الآن', 'add_server_wizard')],
                [Markup.button.callback('🔙 رجوع', 'main_menu')]
            ]));
        } catch (e) { /* Ignore if message not modified */ }
        return;
    }
    const text = message || 'اختر سيرفراً لإدارته:';
    const buttons = servers.map(s => {
        const statusIcon = s.status === 'نشط' ? '🟢' : (s.status === 'متوقف' ? '🔴' : '🟡');
        return [Markup.button.callback(`${statusIcon} ${s.serverName} (${s.ip})`, `manage_server:${s._id}`)];
    });
    buttons.push([Markup.button.callback('🔄 تحديث', 'my_servers')]);
    buttons.push([Markup.button.callback('🔙 رجوع', 'main_menu')]);
    try {
        await ctx.editMessageText(text, Markup.inlineKeyboard(buttons));
    } catch (e) { /* Ignore if message not modified */ }
}

bot.action('my_servers', async (ctx) => { await showMyServers(ctx); });

bot.action(/manage_server:(.+)/, async (ctx) => {
    const serverId = ctx.match[1];
    await manageServerAction(ctx, serverId);
});

bot.action(/start_bot:(.+)/, async (ctx) => { try { await ctx.answerCbQuery('جاري إرسال أمر التشغيل...'); } catch(e) {/*ignore*/} await startBot(ctx, ctx.match[1]); });
bot.action(/stop_bot:(.+)/, async (ctx) => { await stopBot(ctx, ctx.match[1]); });
bot.action(/toggle_autorestart:(.+)/, async (ctx) => { try { await ctx.answerCbQuery(); } catch(e) {/*ignore*/} const s = await Servers.findById(ctx.match[1]); await Servers.updateOne({_id: s._id}, { $set: { autoRestart: !s.autoRestart } }); ctx.update.callback_query.data = `manage_server:${ctx.match[1]}`; await bot.handleUpdate(ctx.update); });
bot.action(/toggle_notify:(.+)/, async (ctx) => { try { await ctx.answerCbQuery(); } catch(e) {/*ignore*/} const s = await Servers.findById(ctx.match[1]); await Servers.updateOne({_id: s._id}, { $set: { notifyOnError: !s.notifyOnError } }); ctx.update.callback_query.data = `manage_server:${ctx.match[1]}`; await bot.handleUpdate(ctx.update); });
bot.action(/info_server:(.+)/, async (ctx) => {
    try {
        await ctx.answerCbQuery('جاري جلب المعلومات...');
    } catch (e) { /* ignore */ }
    const server = await Servers.findById(ctx.match[1]);
    if (!server) return;
    if (server.serverType === 'java') {
        try {
            await ctx.answerCbQuery('❌ لم تعد سيرفرات جافا مدعومة.', { show_alert: true });
        } catch (e) { /* ignore */ }
        return;
    }
    try {
        const result = await statusBedrock(server.ip, server.port, { timeout: 5000 });
        let info = `📊 معلومات السيرفر ${server.serverName}\n\n` + 
                   `النسخة: ${result.version.name_clean || result.version.name}\n` + 
                   `اللاعبون: ${result.players.online} / ${result.players.max}\n`;
        if(result.motd) info += `الوصف:\n${result.motd.clean}`;
        await ctx.editMessageText(info, { reply_markup: { inline_keyboard: [[Markup.button.callback('🔙 رجوع', `manage_server:${ctx.match[1]}`)]] } });
    } catch (e) {
        console.log(`فشل جلب معلومات السيرفر (${server.serverName}):`, e.message);
        try {
            await ctx.answerCbQuery(`❌ لا يمكن الوصول للسيرفر حالياً.`, { show_alert: true });
        } catch (e) { /* ignore */ }
    }
});

bot.action(/delete_confirm:(.+)/, async (ctx) => { try { await ctx.editMessageText('هل أنت متأكد من انك تريد حذف هذا السيرفر 😶 ', Markup.inlineKeyboard([[Markup.button.callback('نعم احذفه ✅', `delete_do:${ctx.match[1]}`), Markup.button.callback('لا الغي العملية 😱', `manage_server:${ctx.match[1]}`)]])); } catch(e) {/*ignore*/} });
bot.action(/delete_do:(.+)/, async (ctx) => { try { await ctx.answerCbQuery('جاري الحذف...'); } catch(e) {/*ignore*/} const sId = ctx.match[1]; await stopBot(ctx, sId).catch(()=>{}); await Servers.deleteOne({ _id: sId, userId: ctx.from.id });

// ✨ إعادة ترتيب السيرفرات بعد الحذف
await reorderServers(ctx.from.id); await showMyServers(ctx, '✅ تم حذف السيرفر.'); });



bot.action('admin_panel', async (ctx) => {
    const user = await Users.findOne({ userId: ctx.from.id });
    if (user?.isAdmin !== true) {
        try {
            return ctx.answerCbQuery('❌ أنت لست مسؤولاً.', { show_alert: true });
        } catch (e) { /* ignore */ }
        return;
    }
    const text = '👑 أهلاً بك في لوحة تحكم المطور.';
    const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('📊 الإحصائيات', 'admin_stats'), Markup.button.callback('📣 إذاعة للكل', 'admin_broadcast')],
        [Markup.button.callback('👤 إدارة المستخدمين', 'admin_users'), Markup.button.callback('🖥️ عرض كل السيرفرات', 'admin_all_servers')],
        [Markup.button.callback('⚙️ إدارة الإصدارات', 'admin_versions'), Markup.button.callback('🔑 إدارة المسؤولين', 'admin_manage_admins')],
        [Markup.button.callback('🖥️ حالة النظام', 'admin_system')],
        [Markup.button.callback('🔧 إعدادات البوت', 'admin_settings')],
        [Markup.button.callback('🔙 رجوع', 'main_menu')]
    ]);
    try {
        await ctx.editMessageText(text, keyboard);
    } catch (e) { /* ignore */ }
});
bot.action('admin_channels', async (ctx) => {
    const config = await readDb('config.json');
    const channels = config.requiredChannels || [];

    let message = '📢 إدارة قنوات الاشتراك الإجباري\n\n';
    if (channels.length > 0) {
        message += 'القنوات الحالية:\n';
        channels.forEach(ch => { message += `- ${ch}\n`; });
    } else {
        message += 'لا توجد قنوات اشتراك إجباري حالياً.';
    }

    const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('➕ إضافة قناة', 'admin_add_channel'), Markup.button.callback('➖ حذف قناة', 'admin_remove_channel')],
        [Markup.button.callback('🔙 رجوع', 'admin_settings')]
    ]);

    try {
        await ctx.editMessageText(message, { ...keyboard });
    } catch (e) { /* ignore */ }
});

bot.action('admin_add_channel', (ctx) => ctx.scene.enter('admin-add-channel-scene'));
bot.action('admin_remove_channel', (ctx) => ctx.scene.enter('admin-remove-channel-scene'));
bot.action('admin_stats', async (ctx) => {
    const totalUsers = await Users.countDocuments();
    const bannedUsers = await Users.countDocuments({ isBanned: true });
    const adminUsers = await Users.countDocuments({ isAdmin: true });
    const totalServers = await Servers.countDocuments();
    const activeBots = await Servers.countDocuments({ status: 'نشط' });
    const text = `📊 إحصائيات البوت:\n\n` + 
                 `👤 إجمالي المستخدمين: ${totalUsers}\n` + 
                 `👑 المسؤولون: ${adminUsers}\n` + 
                 `🚫 المحظورون: ${bannedUsers}\n` + 
                 `🗄️ إجمالي السيرفرات: ${totalServers}\n` + 
                 `🟢 البوتات النشطة: ${activeBots}`;
    try {
        await ctx.editMessageText(text, { reply_markup: { inline_keyboard: [[Markup.button.callback('🔙 رجوع', 'admin_panel')]] } });
    } catch (e) { /* ignore */ }
});

bot.action('admin_system', async (ctx) => {
    try {
        await ctx.answerCbQuery('جاري جلب حالة النظام...');

        // First read to start monitoring, then wait for a more accurate reading
        await pidusage(process.pid);
        await new Promise(resolve => setTimeout(resolve, 1000));
        const stats = await pidusage(process.pid);

        const totalMem = os.totalmem() / 1024 / 1024; // MB
        const freeMem = os.freemem() / 1024 / 1024;   // MB
        const usedMem = totalMem - freeMem;

        // Calculate memory usage of all child bot processes
        const servers = await Servers.find({ status: 'نشط' });
        let childProcessesMemory = 0;
        for (const server of servers) {
            if (server.botPid) {
                try {
                    const childStats = await pidusage(server.botPid);
                    childProcessesMemory += childStats.memory;
                } catch (e) {
                    // Ignore errors if a process doesn't exist (e.g., it crashed)
                }
            }
        }
        const mainProcessMemoryMB = stats.memory / 1024 / 1024;
        const childProcessesMemoryMB = childProcessesMemory / 1024 / 1024;
        const totalBotMemoryMB = mainProcessMemoryMB + childProcessesMemoryMB;

        const text = `🖥️ *حالة النظام والبوت:*

` +
                     `*النظام:*
` +
                     `⚡ استهلاك المعالج (الكلي): ${stats.cpu.toFixed(2)} %
` +
                     `💾 استهلاك الرام (الكلي): ${usedMem.toFixed(2)} MB / ${totalMem.toFixed(2)} MB

` +
                     `*البوت:*
` +
                     `📦 رام العملية الرئيسية: ${mainProcessMemoryMB.toFixed(2)} MB
` +
                     `📦 رام العمليات الفرعية: ${childProcessesMemoryMB.toFixed(2)} MB
` +
                     `📊 *إجمالي رام البوت: ${totalBotMemoryMB.toFixed(2)} MB*

` +
                     `🕒 مدة التشغيل: ${(process.uptime() / 3600).toFixed(2)} ساعة`;

        await ctx.editMessageText(text, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [Markup.button.callback('🔄 تحديث', 'admin_system')],
                    [Markup.button.callback('🔙 رجوع', 'admin_panel')]
                ]
            }
        });
    } catch (e) {
        console.error(e);
        try {
            await ctx.answerCbQuery('❌ حدث خطأ أثناء جلب الحالة.', { show_alert: true });
        } catch (e) { /* ignore */ }
    }
});

bot.action(/delete_all_servers:(\d+)/, async (ctx) => {
    const userId = parseInt(ctx.match[1]);
    try {
        const servers = await Servers.find({ userId });
        if (servers.length === 0) {
            return ctx.answerCbQuery('❌ هذا المستخدم لا يملك أي سيرفرات.', { show_alert: true });
        }

        // احذف كل السيرفرات
        for (const server of servers) {
            await stopBot(ctx, server._id).catch(() => {});
            await Servers.deleteOne({ _id: server._id, userId });
        }

        // ✅ إعادة جلب بيانات المستخدم
        const user = await Users.findOne({ userId });
        const serverCount = 0; // لأن كلها انحذفت
        const joinedDate = new Date(user.joinedAt).toLocaleString('en-GB', { 
        timeZone: 'Asia/Baghdad',
        hour12: false   // 24 ساعة
   });

        let info = `👤 *معلومات المستخدم:*\n\n` + 
           `🆔 User ID: \`${user.userId}\`\n` + 
           `📛 Username: ${user.username || 'غير معروف'}\n` + 
           `📛 Name: ${user.name || 'غير معروف'}\n` + 
           `👑 Admin: ${user.isAdmin ? '✅ Yes' : '❌ No'}\n` + 
           `🚫 Banned: ${user.isBanned ? '✅ Yes' : '❌ No'}\n` + 
           `📅 Joined: ${joinedDate}\n` + 
           `🖥 Servers: ${serverCount}`;

        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback('🗑 حذف جميع السيرفرات', `delete_all_servers:${userId}`)],
            [Markup.button.callback('🔙 رجوع', 'admin_users')]
        ]);

        // ✨ تحديث نفس الرسالة بدلاً من إرسال جديدة
        await ctx.editMessageText(info, { parse_mode: 'Markdown', ...keyboard });

        await ctx.answerCbQuery('✅ تم حذف جميع السيرفرات.', { show_alert: true });
    } catch (e) {
        console.error(e);
        await ctx.answerCbQuery('⚠️ حدث خطأ أثناء الحذف.', { show_alert: true });
    }
});

bot.action('admin_broadcast', (ctx) => ctx.scene.enter('admin-broadcast-wizard'));
bot.action('admin_users', async (ctx) => { try { await ctx.editMessageText('👤 إدارة المستخدمين', Markup.inlineKeyboard([[Markup.button.callback('🚫 حظر', 'user_action:ban'), Markup.button.callback('✅ رفع الحظر', 'user_action:unban')], [Markup.button.callback('ℹ️ عرض معلومات', 'user_action:info')], [Markup.button.callback('🔙 رجوع', 'admin_panel')]])); } catch(e) {/*ignore*/} });
bot.action(/user_action:(.+)/, (ctx) => ctx.scene.enter('admin-user-action-scene', { action: ctx.match[1] }));
bot.action(/rename_bot:(.+)/, (ctx) => ctx.scene.enter('rename-bot-scene', { serverId: ctx.match[1] }));

bot.action('admin_manage_admins', async (ctx) => {
    const allUsers = await Users.find();
    const admins = allUsers.filter(u => u.isAdmin === true && u.userId !== undefined);
    
    let text = '👑 قائمة المسؤولين الحاليين:\n\n';
    
    if (admins.length === 0) {
        text += 'لا يوجد مسؤولين حالياً.';
    } else {
        const sortedAdmins = admins
            .sort((a, b) => a.userId === ADMIN_ID ? -1 : b.userId === ADMIN_ID ? 1 : 0)
            .slice(0, 10);
        
        sortedAdmins.forEach(admin => { 
            const label = admin.userId === ADMIN_ID ? 'المطور الأساسي' : `مسؤول - ${admin.username || 'غير محدد'}`;
            text += `• ${admin.userId} (${label})\n`; 
        });
        
        if (admins.length > 10) {
            text += `\n... و ${admins.length - 10} مسؤولين آخرين`;
        }
        
        text += `\n\n🔍 إجمالي المسؤولين: ${admins.length}`;
    }
    
    try {
        await ctx.editMessageText(text, { 
            reply_markup: { 
                inline_keyboard: [
                    [Markup.button.callback('➕ إضافة مسؤول', 'admin_action:add'), Markup.button.callback('➖ إزالة مسؤول', 'admin_action:remove')], 
                    [Markup.button.callback('🔙 رجوع', 'admin_panel')]
                ] 
            } 
        });
    } catch (e) { /* ignore */ }
});
bot.action(/admin_action:(add|remove)/, (ctx) => ctx.scene.enter('admin-action-scene', { action: ctx.match[1] }));

bot.action('admin_versions', async (ctx) => { try { await ctx.editMessageText('⚙️ إدارة إصدارات ماينكرافت.', Markup.inlineKeyboard([[Markup.button.callback('📋 عرض الكل', 'admin_list_versions')], [Markup.button.callback('➕ إضافة', 'admin_add_version'), Markup.button.callback('➖ حذف', 'admin_delete_version')], [Markup.button.callback('🔙 رجوع', 'admin_panel')]])); } catch(e) {/*ignore*/} });
bot.action('admin_list_versions', async (ctx) => {
    try {
        await ctx.answerCbQuery('جاري جلب القائمة...');
    } catch (e) { /* ignore */ }
    const versions = await Versions.find({});
    versions.sort((a, b) => b.protocol - a.protocol);
    let bedrockText = '🧱 Bedrock:\n';
    versions
      .filter(v => v.type === 'bedrock')
      .sort((a, b) => b.protocol - a.protocol)
      .forEach(v => {
          bedrockText += `${v.name} -> ${v.protocol}\n`;
      });

    try {
        await ctx.editMessageText(bedrockText, { 
            reply_markup: { inline_keyboard: [[Markup.button.callback('🔙 رجوع', 'admin_versions')]] } 
        });
    } catch (e) { /* ignore */ }
});

bot.action('admin_add_version', (ctx) => ctx.scene.enter('admin-add-version-wizard'));
bot.action('admin_delete_version', (ctx) => ctx.scene.enter('admin-delete-version-scene'));

bot.action('admin_settings', async (ctx) => {
    const config = await readDb('config.json');
    const botOnline = config.botOnline ?? true;
    try {
        await ctx.editMessageText('🔧 إعدادات البوت العامة', Markup.inlineKeyboard([[Markup.button.callback(`حالة البوت: ${botOnline ? 'يعمل ✅' : 'متوقف ❌'}`, 'admin_toggle_bot_status')],[Markup.button.callback('📢 إدارة قنوات الاشتراك', 'admin_channels')], [Markup.button.callback('🔙 رجوع', 'admin_panel')]]));
    } catch (e) { /* ignore */ }
});
bot.action('admin_toggle_bot_status', async (ctx) => {
    let config = await readDb('config.json');
    const currentStatus = config.botOnline ?? true;
    config.botOnline = !currentStatus;
    await writeDb('config.json', config);
    try {
        await ctx.answerCbQuery(`تم تغيير حالة البوت إلى: ${!currentStatus ? 'يعمل' : 'متوقف'}`);
    } catch (e) { /* ignore */ }
    ctx.update.callback_query.data = 'admin_settings';
    await bot.handleUpdate(ctx.update);
});
bot.action('admin_all_servers', (ctx) => showAllServers(ctx, 1));

bot.action(/admin_all_servers:(\d+)/, (ctx) => {
    const page = parseInt(ctx.match[1]);
    showAllServers(ctx, page);
});
const startBotApp = async () => {
    try {
        await loadDb(); // Load the database into memory
        await setupInitialConfig();
        await bot.launch();
        console.log('Telegram bot is running.');
    } catch (err) {
        console.error("Failed to initialize and launch the bot:", err);
        process.exit(1);
    }
};

startBotApp();

async function gracefulStop(signal) {
    console.log(`Received ${signal}. Shutting down gracefully...`);
    bot.stop(signal);
    await flushDb(); // Ensure all pending changes are saved
    process.exit(0);
}

process.once('SIGINT', () => gracefulStop('SIGINT'));
process.once('SIGTERM', () => gracefulStop('SIGTERM'));
