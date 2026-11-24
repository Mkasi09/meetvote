import { DatabaseSync } from "node:sqlite";
import { createInterface } from "node:readline/promises";
import { resetAdminPassword } from "../src/admin-password.js";

const databasePath = process.env.DATABASE_PATH || "./data/meetvote.sqlite";

function readHidden(prompt) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Run this command in an interactive terminal so the password can be hidden.");
  }
  return new Promise((resolve, reject) => {
    let value = "";
    const stdin = process.stdin;
    const finish = (error) => {
      stdin.removeListener("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write("\n");
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk) => {
      for (const character of chunk) {
        if (character === "\u0003") return finish(new Error("Password reset cancelled."));
        if (character === "\r" || character === "\n") return finish();
        if (character === "\u007f" || character === "\b") value = value.slice(0, -1);
        else if (character >= " ") value += character;
      }
    };

    process.stdout.write(prompt);
    stdin.setEncoding("utf8");
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

async function main() {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  let email;
  try {
    email = await prompt.question("Administrator email: ");
  } finally {
    prompt.close();
  }

  const password = await readHidden("New password (minimum 12 characters): ");
  const confirmation = await readHidden("Confirm new password: ");
  if (password !== confirmation) throw new Error("Passwords do not match.");

  const db = new DatabaseSync(databasePath);
  try {
    const account = resetAdminPassword(db, email.trim(), password);
    console.log(`Administrator password updated for ${account.email}. You can now sign in to Elawini Estate MeetVote.`);
  } finally {
    db.close();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
