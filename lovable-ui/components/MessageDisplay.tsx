import { type SDKMessage } from "@anthropic-ai/claude-code";
import { useState, useEffect } from "react";

interface MessageDisplayProps {
  messages: SDKMessage[];
}

type ToolUseBlock = {
  type: "tool_use";
  name?: string;
  input?: {
    file_path?: string;
    command?: string;
  };
};

type DisplayMessage = SDKMessage | ToolUseBlock;

function getToolUseBlocks(message: SDKMessage): ToolUseBlock[] {
  if (message.type !== "assistant") {
    return [];
  }

  const content = message.message.content;

  if (!Array.isArray(content)) {
    return [];
  }

  return content.filter(
    (block): block is ToolUseBlock =>
      typeof block === "object" &&
      block !== null &&
      "type" in block &&
      block.type === "tool_use"
  );
}

function getDisplayMessages(messages: SDKMessage[]): DisplayMessage[] {
  return messages.flatMap<DisplayMessage>((message) => {
    if (message.type === "assistant") {
      return [message, ...getToolUseBlocks(message)];
    }

    if (message.type === "result") {
      return [message];
    }

    return [];
  });
}

export default function MessageDisplay({ messages }: MessageDisplayProps) {
  const [generatedPages, setGeneratedPages] = useState<string[]>([]);
  
  useEffect(() => {
    // Look for generated pages
    const pages = messages
      .flatMap(getToolUseBlocks)
      .filter((m) => 
        m.name === 'Write' && 
        m.input?.file_path?.includes('/app/') &&
        (m.input?.file_path?.endsWith('.tsx') || m.input?.file_path?.endsWith('/page.tsx'))
      )
      .map((m) => {
        const path = m.input?.file_path ?? "";
        const match = path.match(/\/app\/([^\/]+)\//);
        return match ? `/${match[1]}` : null;
      })
      .filter((page): page is string => page !== null);
    
    setGeneratedPages(Array.from(new Set(pages)));
  }, [messages]);
  
  if (messages.length === 0) return null;
  
  // Filter to show only assistant messages and tool uses
  const displayMessages = getDisplayMessages(messages);
  
  return (
    <div className="mt-8 max-w-4xl mx-auto px-4">
      <div className="bg-gray-900/50 backdrop-blur-sm rounded-2xl border border-gray-800 p-6 max-h-[600px] overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-white">AI Assistant</h3>
          {generatedPages.length > 0 && (
            <div className="flex gap-2">
              {generatedPages.map((page, idx) => (
                <a
                  key={idx}
                  href={page}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="px-3 py-1 bg-green-600 hover:bg-green-700 text-white text-sm rounded-lg transition-colors"
                >
                  Open {page} →
                </a>
              ))}
            </div>
          )}
        </div>
        
        <div className="space-y-3">
          {displayMessages.map((message, index) => {
            // Assistant messages
            if (message.type === 'assistant' && message.message?.content) {
              const content = message.message.content;
              const textContent = Array.isArray(content) 
                ? content.find((c: any) => c.type === 'text')?.text 
                : content;
                
              if (!textContent) return null;
              
              return (
                <div key={index} className="animate-fadeIn">
                  <div className="text-gray-300 leading-relaxed">
                    {textContent}
                  </div>
                </div>
              );
            }
            
            // Tool uses - show as compact status
            if (message.type === 'tool_use') {
              const toolName = message.name ?? "unknown";
              const input = message.input;
              
              return (
                <div key={index} className="animate-fadeIn">
                  <div className="flex items-center gap-2 text-sm text-gray-500">
                    <div className="w-2 h-2 bg-blue-500 rounded-full animate-pulse" />
                    <span className="font-mono">
                      {toolName === 'Write' && input?.file_path && 
                        `Creating ${input.file_path.split('/').pop()}`}
                      {toolName === 'Edit' && input?.file_path && 
                        `Editing ${input.file_path.split('/').pop()}`}
                      {toolName === 'Read' && input?.file_path && 
                        `Reading ${input.file_path.split('/').pop()}`}
                      {toolName === 'Bash' && input?.command && 
                        `Running: ${input.command.substring(0, 50)}...`}
                      {!['Write', 'Edit', 'Read', 'Bash'].includes(toolName) && 
                        `Using ${toolName}`}
                    </span>
                  </div>
                </div>
              );
            }
            
            // Final result
            if (message.type === 'result' && message.subtype === 'success') {
              return (
                <div key={index} className="animate-fadeIn mt-4">
                  <div className="bg-green-900/20 border border-green-700 rounded-lg p-4">
                    <div className="text-green-400 font-semibold mb-2">✅ Generation Complete</div>
                    <div className="text-gray-300 text-sm">
                      {message.result}
                    </div>
                    {message.total_cost_usd && (
                      <div className="text-xs text-gray-500 mt-2">
                        Cost: ${message.total_cost_usd.toFixed(4)}
                      </div>
                    )}
                  </div>
                </div>
              );
            }
            
            return null;
          })}
          
          {/* Show typing indicator if still generating */}
          {messages.length > 0 && !messages.some((m: any) => m.type === 'result') && (
            <div className="flex items-center gap-2 text-gray-500">
              <div className="flex gap-1">
                <div className="w-2 h-2 bg-gray-500 rounded-full animate-bounce" style={{animationDelay: '0ms'}} />
                <div className="w-2 h-2 bg-gray-500 rounded-full animate-bounce" style={{animationDelay: '150ms'}} />
                <div className="w-2 h-2 bg-gray-500 rounded-full animate-bounce" style={{animationDelay: '300ms'}} />
              </div>
              <span className="text-sm">AI is working...</span>
            </div>
          )}
        </div>
      </div>
      
      <style jsx>{`
        @keyframes fadeIn {
          from {
            opacity: 0;
            transform: translateY(10px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
        
        .animate-fadeIn {
          animation: fadeIn 0.3s ease-out;
        }
      `}</style>
    </div>
  );
}