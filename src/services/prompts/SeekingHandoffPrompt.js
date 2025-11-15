const BasePromptBuilder = require('./BasePromptBuilder');

/**
 * Prompt builder for SEEKING_HANDOFF state
 * Focused on providing helpful info and encouraging connection with Support Specialist
 */
class SeekingHandoffPrompt extends BasePromptBuilder {
    constructor(contextWeights) {
        super(contextWeights);
    }

    /**
     * Build the complete prompt for SEEKING_HANDOFF state
     */
    buildPrompt(searchResult) {
        let knowledgeSection;
        if (!searchResult.context) {
            knowledgeSection = `NO KNOWLEDGE FOUND: You don't have information about this topic. Do NOT make up answers. Instead, acknowledge you don't have that specific information and offer to connect them with a Support Specialist who can help.`;
        } else {
            knowledgeSection = this.buildKnowledgeContext(searchResult);
        }

        return `${this.buildRoleSection()}

${knowledgeSection}

Task: Answer NDIS questions, build trust, encourage connection with Support Specialist. Try and include the url links when appropriate.

${this.buildOutputRules()}`;
    }
}

module.exports = SeekingHandoffPrompt;