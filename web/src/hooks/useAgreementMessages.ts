import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { gatewayFetch } from "@/lib/gateway";

export interface AgreementMessage {
  id: string;
  agreement_id: number;
  sender_agent_id: string;
  message_type: string;
  content: string;
  attachment_cid: string | null;
  created_at: string;
}

interface MessagesResponse {
  messages: AgreementMessage[];
  limit: number;
  offset: number;
}

interface SendMessageInput {
  messageType?: string;
  content: string;
  attachmentCid?: string;
}

/**
 * Fetches and manages the message thread for an agreement.
 * Party-only: returns 403 for non-parties.
 */
export function useAgreementMessages(agreementId: string | undefined) {
  const queryClient = useQueryClient();
  const queryKey = ["agreement-messages", agreementId ?? ""];

  const query = useQuery<MessagesResponse, Error>({
    queryKey,
    queryFn: () => gatewayFetch<MessagesResponse>(`/v1/marketplace/agreements/${agreementId}/messages`),
    enabled: !!agreementId,
    staleTime: 15_000,
    refetchInterval: 30_000,
  });

  const mutation = useMutation<AgreementMessage, Error, SendMessageInput>({
    mutationFn: (input) =>
      gatewayFetch<AgreementMessage>(`/v1/marketplace/agreements/${agreementId}/messages`, {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey });
    },
  });

  return {
    messages: query.data?.messages ?? [],
    isLoading: query.isLoading,
    error: query.error,
    sendMessage: mutation.mutate,
    isSending: mutation.isPending,
    sendError: mutation.error,
  };
}
