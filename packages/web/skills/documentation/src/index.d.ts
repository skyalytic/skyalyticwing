export declare const DocumentationSkill: {
    id: string;
    name: string;
    description: string;
    triggers: string[];
    systemPrompt: string;
    tools: string[];
    execute: (context: any) => Promise<{
        filesGenerated: never[];
        coverage: number;
    }>;
};
export default DocumentationSkill;
//# sourceMappingURL=index.d.ts.map