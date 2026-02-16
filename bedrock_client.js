const bedrock = require('bedrock-protocol');

const args = process.argv.slice(2);
const serverIp = args[0];
const serverPort = parseInt(args[1]);
const username = args[2];
const version = args[3];

if (!serverIp || !serverPort || !username || !version) {
    console.error('Missing arguments. Required: ip, port, username, version');
    process.exit(1);
}

let hasRetried = false;

function connect() {
    console.log(`Connecting bot ${username} to ${serverIp}:${serverPort}...`);

    try {
        const client = bedrock.createClient({
            host: serverIp,
            port: serverPort,
            username: username,
            version: version,
            offline: true,
            connectTimeout: 10000
        });

        client.on('spawn', () => {
            console.log(`Bot ${username} successfully connected.`);
        });

        client.on('disconnect', (packet) => {
            console.log(`Bot ${username} disconnected. Reason: ${packet.reason}`);
            
            const reason = packet.reason.toLowerCase();
            const isKick = reason.includes('kick') || reason.includes('ban');

            if (isKick && !hasRetried) {
                hasRetried = true;
                console.log('Kicked from server. Attempting to reconnect once in 5 seconds...');
                setTimeout(connect, 5000);
            } else {
                if (isKick) console.log('Already retried. Exiting.');
                else console.log('Exiting.');
                process.exit(0);
            }
        });

        client.on('error', (err) => {
            console.error(`Bot ${username} encountered an error: ${err.message}`);
            
            if (!hasRetried) {
                hasRetried = true;
                console.log('Attempting to reconnect once in 5 seconds due to error...');
                setTimeout(connect, 5000);
            } else {
                console.error('Error occurred on retry attempt. Exiting.');
                process.exit(1);
            }
        });

    } catch (error) {
        console.error(`Failed to create client: ${error.message}`);
        
        if (!hasRetried) {
            hasRetried = true;
            console.log('Attempting to reconnect once in 5 seconds...');
            setTimeout(connect, 5000);
        } else {
            console.error('Failed to create client on retry. Exiting.');
            process.exit(1);
        }
    }
}

// Initial connection
connect();

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('Received SIGINT. Shutting down.');
    process.exit(0);
});
process.on('SIGTERM', () => {
    console.log('Received SIGTERM. Shutting down.');
    process.exit(0);
});
