const BasePromptBuilder = require('./BasePromptBuilder');

/**
 * Prompt builder for LEAD_CAPTURE state
 * Focused on building trust through helpful responses, then offering follow-up after 2-3 exchanges
 */
class LeadCapturePrompt extends BasePromptBuilder {
    constructor(contextWeights) {
        super(contextWeights);
    }

    /**
     * Build the complete prompt for LEAD_CAPTURE state
     */
    buildPrompt(searchResult) {
        let knowledgeSection;
        if (!searchResult.context) {
            knowledgeSection = `NO KNOWLEDGE FOUND: You don't have information about this topic. Do NOT make up answers. Instead, acknowledge you don't have that specific information and offer: "I can organise someone to follow up with personalised info about this. Would you like to leave your details?"`;
        } else {
            knowledgeSection = this.buildKnowledgeContext(searchResult);
        }

        return `${this.buildRoleSection()}

${knowledgeSection}

Task: Answer NDIS questions, build trust. After 2-3 exchanges, offer: "I can organise someone to follow up with personalised info. Would you like to leave your details?" Try and include the url links when appropriate.

${this.buildOutputRules()}`;
    }
}

module.exports = LeadCapturePrompt;