// Test-only transport. Never send real Telegram credentials to a fixture server.
const original=globalThis.fetch;
globalThis.fetch=(input,init)=>{
 const url=String(input);
 if(url.startsWith('https://api.telegram.org/')){
  const target=process.env.FLEET_FIXTURE_API;
  const expected=/^https:\/\/api\.telegram\.org\/bot(?:111111111|222222222|333333333|444444444):(?:FAKE_FIXTURE_NOT_REAL_){2}\/[A-Za-z]+$/;
  if(!target||!/^http:\/\/127\.0\.0\.1:\d+$/.test(target)||!expected.test(url))throw new Error('Fixture refuses non-synthetic Telegram request');
  return original(url.replace('https://api.telegram.org',target),init);
 }
 return original(input,init);
};
