import * as core from '@actions/core';
import { context } from '@actions/github';
import Octokit from '@octokit/rest';
import { App } from '@octokit/app';

async function lockIssue(client: Octokit, issue: number, message: string): Promise<void> {
  await client.issues.createComment({
    owner: context.repo.owner,
    repo: context.repo.repo,
    issue_number: issue,
    body: message,
  });

  // Actually lock the issue
  await client.issues.lock({
    owner: context.repo.owner,
    repo: context.repo.repo,
    issue_number: issue,
  });
}

/** Creates a promise which resolves after a set period of time. */
function timeout(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function run(): Promise<void> {
  try {
    // NOTE: `days` and `message` must not be changed without dev-rel and dev-infra concurrence

    // Fixed amount of days a closed issue must be inactive before being locked
    const days = 30;
    // Standardized Angular Team message for locking issues
    const policyUrl =
      'https://github.com/angular/angular/blob/8f24bc9443b3872fe095d9f7f77b308a361a13b4/docs/GITHUB_PROCESS.md#conversation-locking';
    const message =
      'This issue has been automatically locked due to inactivity.\n' +
      'Please file a new issue if you are encountering a similar or related problem.\n\n' +
      `Read more about our [automatic conversation locking policy](${policyUrl}).\n\n` +
      '<sub>_This action has been performed automatically by a bot._</sub>';
    // Github App Id of the Lock Bot App
    const lockBotAppId = 40213;
    // Installation Id of the Lock Bot App
    const installationId = 1772826;

    // Create JWT Token with provided private key.
    const lockBotKey = core.getInput('lock-bot-key', { required: true });

    // The Angular Lock Bot Github application
    const githubApp = new App({ id: lockBotAppId, privateKey: lockBotKey });

    // A short lived github token for the Angular Lock Bot
    const githubToken = await githubApp.getInstallationAccessToken({ installationId });

    // Create authenticated Github client.
    const client = new Octokit({ auth: githubToken });

    const maxPerExecution = Math.min(+core.getInput('locks-per-execution') || 1, 100);
    // Set the threshold date based on the days inactive
    const threshold = new Date();
    threshold.setDate(threshold.getDate() - days);

    const repositoryName = context.repo.owner + '/' + context.repo.repo;
    const updatedAt = threshold.toISOString().split('T')[0];
    const query = `repo:${repositoryName}+is:closed+is:unlocked+updated:<${updatedAt}+sort:updated-asc`;
    console.info('Query: ' + query);

    let lockCount = 0;
    let issueResponse = await client.search.issuesAndPullRequests({
      q: query,
      per_page: maxPerExecution,
    });

    console.info(`Query found ${issueResponse.data.total_count} items`);

    if (!issueResponse.data.items.length) {
      console.info(`No items to lock`);
      return;
    }

    console.info(`Attempting to lock ${issueResponse.data.items.length} item(s)`);
    core.startGroup('Locking items');
    for (const item of issueResponse.data.items) {
      let itemType: string | undefined;
      try {
        itemType = item.pull_request ? 'pull request' : 'issue';
        if (item.locked) {
          console.info(`Skipping ${itemType} #${item.number}, already locked`);
          continue;
        }
        console.info(`Locking ${itemType} #${item.number}`);
        await lockIssue(client, item.number, message);
        await timeout(500);
        ++lockCount;
      } catch (error) {
        core.debug(error);
        core.warning(`Unable to lock ${itemType} #${item.number}: ${error.message}`);
        if (typeof error.request === 'object') {
          core.error(JSON.stringify(error.request, null, 2));
        }
      }
    }
    core.endGroup();
    console.info(`Locked ${lockCount} item(s)`);
  } catch (error) {
    core.debug(error);
    core.setFailed(error.message);
    if (typeof error.request === 'object') {
      core.error(JSON.stringify(error.request, null, 2));
    }
  }
  console.info(`End of locking task`);
}

// Only run if the action is executed in a repository with is in the Angular org. This is in place
// to prevent the action from actually running in a fork of a repository with this action set up.
if (context.repo.owner === 'angular') {
  run();
} else {
  core.warning(
    'The Automatic Locking Closed issues was skipped as this action is only meant to run ' +
      'in repos belonging to the Angular organization.',
  );
}
