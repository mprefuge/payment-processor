export interface PostingInstructionLine {
  type: 'debit' | 'credit';
  accountName: string;
  accountId?: string;
  amount: number;
  memo?: string;
}

export interface PostingInstruction {
  docNumber: string;
  memo?: string;
  txnDate: string;
  lines: PostingInstructionLine[];
}

export interface PostingStrategy {
  prepareInstructions: (...args: unknown[]) => Promise<PostingInstruction> | PostingInstruction;
  validate?: (instruction: PostingInstruction) => Promise<void> | void;
}
