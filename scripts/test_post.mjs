import fs from 'fs';

async function test() {
  const file1 = fs.readFileSync('2026_NSISC_Championships_Final_Results.pdf').toString('base64');
  
  try {
    const res = await fetch('http://127.0.0.1:3000/api/parse-pdf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ base64: file1 })
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error + " - " + data.details);

    const teams = new Set(data.results.map(r => r.team));
    console.log(`NSISC length: ${data.results.length}`);
    console.log('NSISC Teams:', Array.from(teams));
    
  } catch (e) {
    console.error('Er:', e);
  }
}
test();
