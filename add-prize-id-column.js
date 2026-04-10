const { Pool } = require('pg');

const connectionString = process.argv[2];
if (!connectionString) {
  console.error('Usage: node add-prize-id-column.js <connection-string>');
  process.exit(1);
}

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false }
});

async function main() {
  const client = await pool.connect();
  try {
    console.log('Connected to database...');
    const result = await client.query('ALTER TABLE verification_codes ADD COLUMN prize_id INTEGER REFERENCES prizes(id);');
    console.log('Success! ALTER TABLE executed:', result);
    console.log('✅ Column prize_id added to verification_codes table');
  } catch (err) {
    if (err.message.includes('column "prize_id" of relation "verification_codes" already exists')) {
      console.log('✅ Column already exists, no action needed');
    } else {
      console.error('Error:', err);
      throw err;
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main();
