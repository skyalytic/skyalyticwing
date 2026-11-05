export declare const CodeReviewSkill: {
    id: string;
    name: string;
    description: string;
    triggers: string[];
    systemPrompt: string;
    tools: string[];
    execute: (context: any) => Promise<{
        summary: string;
        issues: never[];
        suggestions: never[];
    }>;
};
export default CodeReviewSkill;
//# sourceMappingURL=index.d.ts.map