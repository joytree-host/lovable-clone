import { NextRequest } from "next/server";
import { generateCodeWithClaude, type SDKMessage } from "@/lib/claude-code";

// FIX: No longer importing from @anthropic-ai/claude-code (it's CLI-only now).
// generateCodeWithClaude in lib/claude-code.ts handles the CLI subprocess.

export async function POST(req: NextRequest) {
  try {
    const { prompt } = await req.json();

    if (!prompt) {
      return new Response(JSON.stringify({ error: "Prompt is required" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    console.log("[API] Starting code generation for prompt:", prompt);

    const encoder = new TextEncoder();
    const stream = new TransformStream();
    const writer = stream.writable.getWriter();

    let writerClosed = false;

    async function safeWrite(data: string) {
      if (!writerClosed) {
        try {
          await writer.write(encoder.encode(data));
        } catch (e) {}
      }
    }

    (async () => {
      try {
        // Stream progress as generation runs
        await safeWrite(
          `data: ${JSON.stringify({ type: "progress", message: "Starting generation..." })}\n\n`
        );

        const result = await generateCodeWithClaude(prompt);

        let messageCount = 0;
        for (const message of result.messages) {
          messageCount++;
          console.log(`[API] Message ${messageCount} - Type: ${message.type}`);

          if (message.type === "tool_use") {
            console.log(`[API] Tool use: ${message.name ?? "unknown"}`);
          } else if (message.type === "result") {
            console.log(`[API] Result: ${message.subtype}`);
          }

          await safeWrite(`data: ${JSON.stringify(message)}\n\n`);
        }

        console.log(
          `[API] Generation complete. Total messages: ${messageCount}`
        );
        await safeWrite("data: [DONE]\n\n");
      } catch (error: any) {
        console.error("[API] Error during generation:", error);
        await safeWrite(
          `data: ${JSON.stringify({ error: error.message })}\n\n`
        );
      } finally {
        if (!writerClosed) {
          writerClosed = true;
          try {
            await writer.close();
          } catch (e) {}
        }
      }
    })();

    return new Response(stream.readable, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  } catch (error: any) {
    console.error("[API] Error:", error);
    return new Response(
      JSON.stringify({ error: error.message || "Internal server error" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}
