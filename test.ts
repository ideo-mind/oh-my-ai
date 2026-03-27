// gemini-test.ts
const url =
  "http://localhost:8990/gemini/models/gemini-2.5-flash:generateContent";

const body = {
  contents: [
    {
      role: "user",
      parts: [
        {
          text: "Hello! Please say hello back.",
        },
      ],
    },
  ],
};

async function main() {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "x-goog-api-key": "baby",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  console.log("status:", res.status, res.statusText);
  const json = await res.json().catch(async () => ({
    text: await res.text(),
  }));
  console.log("response:", json);
}

main().catch((err) => {
  console.error("request failed:", err);
  process.exit(1);
});

