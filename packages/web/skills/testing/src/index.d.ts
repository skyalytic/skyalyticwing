export declare const TestingSkill: {
    id: string;
    name: string;
    description: string;
    triggers: string[];
    systemPrompt: string;
    tools: string[];
    execute: (context: any) => Promise<{
        testsGenerated: number;
        coverage: number;
    }>;
};
export default TestingSkill;
//# sourceMappingURL=index.d.ts.map