#!/usr/bin/env node

// Redis cleanup script - clears all session data
require('dotenv').config();
const redis = require('redis');

async function clearAllRedisData() {
    console.log('🧹 Starting Redis cleanup...');
    
    let client;
    try {
        // Since we need to connect from local machine, try the public Redis URL
        // You'll need to replace the domain and port manually
        const password = process.env.REDIS_PASSWORD || 'dptkByyVTizQOEzrJInZMAkHuMFRemGP';
        
        // You need to get the actual TCP proxy domain and port from Railway
        console.log('❌ This script needs to be run from the Railway environment');
        console.log('💡 Alternative: Go to Railway dashboard → Redis service → Connection tab');
        console.log('💡 Look for the actual TCP proxy URL and replace it below:');
        console.log('');
        console.log('Example: redis://default:' + password + '@viaduct.proxy.rlwy.net:12345');
        console.log('');
        console.error('❌ Cannot connect to Railway Redis from local machine without TCP proxy details');
        process.exit(1);
        
        client = redis.createClient({ url: finalRedisUrl });
        client.on('error', (err) => console.error('Redis Client Error:', err));
        
        await client.connect();
        console.log('✅ Connected to Redis');
        
        // Get all keys to see what we're deleting
        const allKeys = await client.keys('*');
        console.log(`📋 Found ${allKeys.length} keys in Redis:`);
        
        if (allKeys.length > 0) {
            // Group keys by type for better visibility
            const keysByType = {};
            allKeys.forEach(key => {
                const prefix = key.split(':')[0];
                if (!keysByType[prefix]) keysByType[prefix] = [];
                keysByType[prefix].push(key);
            });
            
            Object.entries(keysByType).forEach(([prefix, keys]) => {
                console.log(`  ${prefix}: ${keys.length} keys`);
            });
            
            // Clear all keys
            console.log('🗑️  Deleting all Redis data...');
            await client.flushAll();
            console.log('✅ All Redis data cleared successfully!');
        } else {
            console.log('ℹ️  Redis is already empty');
        }
        
    } catch (error) {
        console.error('❌ Error clearing Redis:', error.message);
        process.exit(1);
    } finally {
        if (client) {
            await client.disconnect();
            console.log('🔌 Disconnected from Redis');
        }
    }
    
    console.log('🎉 Redis cleanup complete!');
    process.exit(0);
}

// Run the cleanup
clearAllRedisData();