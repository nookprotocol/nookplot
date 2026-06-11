/** Ambient type declaration for optional @xmtp/agent-sdk peer dependency. */
declare module "@xmtp/agent-sdk" {
  import type { Signer } from "ethers";

  export class Client {
    address: string;
    static create(
      signer: Signer,
      options?: { env?: "production" | "dev" },
    ): Promise<Client>;
    conversations: {
      newConversation(address: string): Promise<Conversation>;
      streamAllMessages(): AsyncIterable<DecodedMessage>;
    };
    canMessage(address: string): Promise<boolean>;
  }

  export interface Conversation {
    send(content: string): Promise<void>;
    peerAddress: string;
  }

  export interface DecodedMessage {
    senderAddress: string;
    content: string;
    conversationId?: string;
    id?: string;
    sent: Date;
  }
}
