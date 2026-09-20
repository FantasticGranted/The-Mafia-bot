const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');

const TOKEN = process.env.BOT_TOKEN;
const PREFIX = '!';
const GUILD_NAME = 'The Mafia';

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ],
});

client.once('ready', () => {
    console.log(`Logged in as ${client.user.tag}`);
    client.user.setActivity('6b6t | !help', { type: 'Playing' });
});

client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    if (!message.content.startsWith(PREFIX)) return;

    const args = message.content.slice(PREFIX.length).trim().split(/ +/);
    const command = args.shift().toLowerCase();

    if (command === 'help') {
        const embed = new EmbedBuilder()
            .setColor('#c9a84c')
            .setTitle('The Mafia - Commands')
            .setDescription('Clan bot commands')
            .addFields(
                { name: '!roster', value: 'List all members and their roles' },
                { name: '!rules', value: 'Show clan rules' },
                { name: '!rank', value: 'Check your rank in the clan' },
                { name: '!sync', value: 'Generate HTML for the website (admin only)' },
                { name: '!members', value: 'Show member count' },
                { name: '!info', value: 'Show clan info' },
            );
        message.reply({ embeds: [embed] });
    }

    if (command === 'roster') {
        const guild = message.guild;
        const members = await guild.members.fetch();
        const embed = new EmbedBuilder()
            .setColor('#c9a84c')
            .setTitle(`${GUILD_NAME} - Roster`)
            .setDescription(`Total members: ${members.filter(m => !m.user.bot).size}`);

        const roleGroups = {};
        members.forEach(member => {
            if (member.user.bot) return;
            const topRole = member.roles.highest.name;
            if (!roleGroups[topRole]) roleGroups[topRole] = [];
            roleGroups[topRole].push(member.displayName);
        });

        for (const [role, names] of Object.entries(roleGroups)) {
            embed.addFields({ name: role, value: names.join(', ') || 'None' });
        }

        message.reply({ embeds: [embed] });
    }

    if (command === 'rules') {
        const embed = new EmbedBuilder()
            .setColor('#c9a84c')
            .setTitle(`${GUILD_NAME} - Rules`)
            .setDescription(
                '**1.** Respect all clan members. Toxic behavior will not be tolerated.\n' +
                '**2.** Follow the orders of leaders during operations.\n' +
                '**3.** Do not betray the clan or leak internal information.\n' +
                '**4.** Be active. Inactive members may be removed after 2 weeks.\n' +
                '**5.** Have fun!'
            );
        message.reply({ embeds: [embed] });
    }

    if (command === 'rank') {
        const member = message.member;
        const topRole = member.roles.highest;
        const embed = new EmbedBuilder()
            .setColor('#c9a84c')
            .setTitle(`${message.author.username}'s Rank`)
            .addFields(
                { name: 'Display Name', value: member.displayName, inline: true },
                { name: 'Top Role', value: topRole.name, inline: true },
                { name: 'Joined', value: member.joinedAt.toLocaleDateString(), inline: true },
            );
        message.reply({ embeds: [embed] });
    }

    if (command === 'members') {
        const guild = message.guild;
        const members = await guild.members.fetch();
        const humanCount = members.filter(m => !m.user.bot).size;
        const botCount = members.filter(m => m.user.bot).size;
        const embed = new EmbedBuilder()
            .setColor('#c9a84c')
            .setTitle(`${GUILD_NAME} - Member Count`)
            .addFields(
                { name: 'Humans', value: `${humanCount}`, inline: true },
                { name: 'Bots', value: `${botCount}`, inline: true },
                { name: 'Total', value: `${humanCount + botCount}`, inline: true },
            );
        message.reply({ embeds: [embed] });
    }

    if (command === 'info') {
        const guild = message.guild;
        const embed = new EmbedBuilder()
            .setColor('#c9a84c')
            .setTitle(GUILD_NAME)
            .setDescription('A dominant force on 6b6t')
            .addFields(
                { name: 'Server', value: guild.name, inline: true },
                { name: 'Members', value: `${guild.memberCount}`, inline: true },
                { name: 'Created', value: guild.createdAt.toLocaleDateString(), inline: true },
            );
        message.reply({ embeds: [embed] });
    }

    if (command === 'sync') {
        if (!message.member.permissions.has('Administrator')) {
            return message.reply('You need admin permissions to use this.');
        }

        const guild = message.guild;
        const members = await guild.members.fetch();
        const roleGroups = {};

        members.forEach(member => {
            if (member.user.bot) return;
            const topRole = member.roles.highest.name;
            if (!roleGroups[topRole]) roleGroups[topRole] = [];
            roleGroups[topRole].push({ name: member.displayName, id: member.id });
        });

        let html = '<div class="members-grid" id="members-grid">\n';
        for (const [role, members] of Object.entries(roleGroups)) {
            for (const m of members) {
                const initial = m.name.charAt(0).toUpperCase();
                html += `                <div class="member-card">
                    <div class="member-avatar">${initial}</div>
                    <div class="member-name content-editable" data-content-id="member-${m.id}-name" contenteditable="false">${m.name}</div>
                    <div class="member-role content-editable" data-content-id="member-${m.id}-role" contenteditable="false">${role}</div>
                </div>\n`;
            }
        }
        html += '            </div>';

        const embed = new EmbedBuilder()
            .setColor('#c9a84c')
            .setTitle('Website Sync - Members HTML')
            .setDescription('Copy this and replace the members-grid section in your index.html:\n\n```html\n' + html + '\n```');

        message.reply({ embeds: [embed] });
    }
});

client.login(TOKEN);
