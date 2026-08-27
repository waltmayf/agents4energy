import { getCurrentChatSessionId, setCurrentChatSessionId } from '../context';

/**
 * Set the chat session ID. Delegates to the central context module.
 */
export function setChatSessionId(chatSessionId: string) {
    setCurrentChatSessionId(chatSessionId);
}

/**
 * Get the current chat session ID. Delegates to the central context module.
 */
export function getChatSessionId(): string | undefined {
    return getCurrentChatSessionId();
}

/**
 * Get the S3 prefix for the current chat session's artifacts.
 */
export function getChatSessionPrefix(): string {
    const chatSessionId = getCurrentChatSessionId();
    if (!chatSessionId) {
        throw new Error("Chat session ID not set. Call setChatSessionId first.");
    }
    return `chatSessionArtifacts/sessionId=${chatSessionId}/`;
}
