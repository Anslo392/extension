import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import 'dotenv/config';


// The client gets the API key from the environment variable `GEMINI_API_KEY`.
const ai = new GoogleGenAI({apiKey: process.env.GEMINI_API_KEY});

async function main() {
    const response = await ai.models.generateContentStream({
        model: "gemini-3-flash-preview",
        contents: "INSERT MESSAGE CONTENTS HERE",
        config: {
            systemInstruction: "INSERT PERSONALITY INSTRUCTION HERE",
            thinkingConfig: {
                thinkingLevel: ThinkingLevel.LOW,
            }
        }
    });   
    for await (const chunk of response) {
        console.log(chunk.text);
    }
}

await main();