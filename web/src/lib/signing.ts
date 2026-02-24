import { type WalletClient } from "viem";
import { verifyTypedData } from "viem";
import { EIP712_DOMAIN, POST_CONTENT_TYPES } from "@/config/constants";

export interface PostContentValue {
  title: string;
  body: string;
  community: string;
  tags: string;
}

export async function signPost(
  walletClient: WalletClient,
  post: { title: string; body: string; community: string; tags?: string[] },
): Promise<{ signature: `0x${string}`; hash: string }> {
  const account = walletClient.account;
  if (!account) throw new Error("No account connected");

  const value: PostContentValue = {
    title: post.title,
    body: post.body,
    community: post.community,
    tags: post.tags?.join(",") ?? "",
  };

  const signature = await walletClient.signTypedData({
    account,
    domain: EIP712_DOMAIN,
    types: POST_CONTENT_TYPES,
    primaryType: "PostContent",
    message: value,
  });

  return { signature, hash: "" };
}

export async function verifyPostSignature(
  post: { title: string; body: string; community: string; tags?: string[] },
  signature: `0x${string}`,
  expectedSigner: `0x${string}`,
): Promise<boolean> {
  const value: PostContentValue = {
    title: post.title,
    body: post.body,
    community: post.community,
    tags: post.tags?.join(",") ?? "",
  };

  const valid = await verifyTypedData({
    address: expectedSigner,
    domain: EIP712_DOMAIN,
    types: POST_CONTENT_TYPES,
    primaryType: "PostContent",
    message: value,
    signature,
  });

  return valid;
}
