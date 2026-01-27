// test-ollama-ping.js
const res = await fetch("http://localhost:11434/api/tags");
if (!res.ok) {
  console.error("❌ Ollama không chạy hoặc không connect được");
  process.exit(1);
}
const data = await res.json();
console.log("✅ Ollama đang chạy");
console.log("Models có sẵn:", data.models.map(m => m.name));
