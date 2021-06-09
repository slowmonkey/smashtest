const RunInstance = require('./runinstance.js');
const Tree = require('./tree.js');
const chalk = require('chalk');
const utils = require('./utils.js');

/**
 * Test runner
 */
class Runner {
    /**
     * Generates the runner
     */
    constructor() {
        this.tree = null;                // The tree to run (just parsed in)
        this.reporter = null;            // The Reporter to use

        this.flags = {};                 // Flags passed in through the command line (e.g., --max-parallel=7 --no-debug --groups="one,two" --> {"max-parallel": "7", "no-debug": "true", "groups": "one,two"})

        this.debugHash = undefined;      // Set to the hash of the branch to run as debug (overrides any $'s, ~'s, groups, or minFrequency)
        this.groups = undefined;         // Array of array of string. Only run branches whose groups match the expression, no restrictions if this is undefined, --groups=a,b+c === [ ['a'], ['b', 'c'] ] === A or (B and C)
        this.headless = undefined;       // If true, run external processes (e.g., browsers) as headless, if possible
        this.maxParallel = 5;            // The maximum number of simultaneous branches to run
        this.maxScreenshots = -1;        // The maximum number of screenshots to take, -1 for no limit
        this.minFrequency = undefined;   // Only run branches at or above this frequency, no restrictions if this is undefined
        this.noDebug = false;            // If true, a compile error will occur if a $, ~, or ~~ is present anywhere in the tree
        this.outputErrors = true;        // If true, output errors to console
        this.random = true;              // If true, randomize the order of branches
        this.screenshots = false;        // If true, take screenshots before and after each step
        this.showProgressBar = true;     // If true, shows progress bar in the output of the console.
        this.skipPassed = undefined;     // If true, carry over branches that passed last time
        this.testServer = undefined;     // Location of test server (e.g., http://localhost:4444/wd/hub for selenium server)

        this.pauseOnFail = false;        // If true, pause when a step fails (there must only be one branch in the tree)
        this.consoleOutput = true;       // If true, output debug info to console
        this.isRepl = false;             // If true, run in REPL mode

        this.persistent = {};            // stores variables which persist from branch to branch, for the life of the Runner
        this.globalInit = {};            // init each branch with these global variables
        this.runInstances = [];          // the currently-running RunInstance objects, each running a branch

        this.isPaused = false;           // True if this runner has been paused (set by the RunInstance within this.runInstances)
        this.isStopped = false;          // True if this runner has been stopped
        this.isComplete = false;         // True if this runner is done running its tree

        this.screenshotCount = 0;        // Number of screenshots taken
    }

    /**
     * Initializes the runner with a tree and reporter
     * @param {Tree} tree - The tree to use
     * @param {Boolean} [noRandom] - If true, does not randomly sort branches
     */
    init(tree, noRandom) {
        this.tree = tree;

        this.tree.groups = this.groups;
        this.tree.minFrequency = this.minFrequency;
        this.tree.noDebug = this.noDebug;
        this.tree.debugHash = this.debugHash;
        this.tree.noRandom = noRandom || !this.random;
        this.tree.noCondNonParallel = typeof this.testServer != 'undefined';

        this.tree.generateBranches();

        // If headless not set, set it to true, unless we're debugging with ~
        if(typeof this.headless == 'undefined') {
            this.headless = (!this.tree.isDebug || this.tree.isExpressDebug) && !this.isRepl;
        }
    }

    /**
     * Starts or resumes running the branches from this.tree
     * Parallelizes runs to up to this.maxParallel simultaneously running tests
     * @return {Promise} Promise that gets resolved with true if completed, false otherwise
     */
    async run() {
        this.tree.timeStarted = new Date();
        await this.startReporter();

        let numInstances = Math.min(this.maxParallel, this.tree.branches.length);

        // If ~ is set on any step, pauseOnFail will be set
        if(this.tree.isDebug && !this.tree.isExpressDebug) {
            this.pauseOnFail = true;
        }

        if(this.isStopped) { // starting from a stop
            utils.error("Cannot run a stopped runner");
        }
        else if(this.isPaused) { // starting from a pause
            await this.runInstances[0].run(); // resume that one branch that was paused
            if(this.isPaused) {
                this.tree.elapsed = -1;
            }
            else {
                await this.end();
            }
        }
        else { // starting from the beginning
            if(await this.runBeforeEverything()) {
                // Before Everythings passed
                await this.runBranches(numInstances);
                await this.end();
            }
            else {
                await this.end();
            }
        }

        await this.stopReporter();

        return this.getNextReadyStep() == null;
    }

    /**
     * Ends all running RunInstances and runs all After Everything hooks
     * @return {Promise} Promise that resolves when stopping is complete
     */
    async stop() {
        if(!this.isStopped && !this.isComplete) {
            this.isStopped = true;
            this.runInstances.forEach(runInstance => {
                runInstance.stop();
            });

            await this.runAfterEverything();
            await this.stopReporter();
        }
    }

    /**
     * Runs the next step, then pauses
     * Call only when already paused
     * @return {Promise} Promise that resolves once the execution finishes, resolves to true if the branch is complete (including After Every Branch hooks), false otherwise
     */
    async runOneStep() {
        if(!this.isPaused) {
            utils.error("Must be paused to run a step");
        }

        let isBranchComplete = await this.runInstances[0].runOneStep();
        if(isBranchComplete) {
            await this.runAfterEverything();
        }

        return isBranchComplete;
    }

    /**
     * Skips the next step, then pauses
     * Call only when already paused
     * @return {Promise} Promise that resolves once the execution finishes, resolves to true if the branch is complete (including After Every Branch hooks), false otherwise
     */
    async skipOneStep() {
        if(!this.isPaused) {
            utils.error("Must be paused to skip a step");
        }

        let isBranchComplete = await this.runInstances[0].skipOneStep();
        if(isBranchComplete) {
            await this.runAfterEverything();
        }

        return isBranchComplete;
    }

    /**
     * Reruns the previous step
     * @return {Promise} Promise that resolves once the execution finishes
     */
    async runLastStep() {
        if(!this.isPaused) {
            utils.error("Must be paused to run a step");
        }

        await this.runInstances[0].runLastStep();
    }

    /**
     * Runs the given text in the context of the first RunInstance in this.runInstances, then pauses
     * Call only when already paused
     * @param {String} text - The step text to run
     * @return {Promise} Promise that gets resolved with a Branch of steps that were run, once done executing
     * @throws {Error} If a parse error of text occurs, or if this Runner isn't paused
     */
    async inject(text) {
        if(!this.isPaused) {
            utils.error("Must be paused to run a step");
        }

        let branchRan = await this.runInstances[0].inject(text);

        return branchRan;
    }

    /**
     * @return {Step} The next not-yet-completed step in the first RunInstance, or null if the first RunInstance's branch is done
     */
    getNextReadyStep() {
        if(this.runInstances.length == 0) {
            return null;
        }
        else {
            return this.runInstances[0].getNextReadyStep();
        }
    }

    /**
     * @return {Step} The last step run, null if none
     */
    getLastStep() {
        return this.runInstances[0].getLastStep();
    }

    /**
     * Creates a single empty RunInstance and pauses it
     * Will be used by --repl
     */
    createEmptyRunner(tree) {
        this.tree = tree;
        this.runInstances = [ new RunInstance(this) ];
        this.runInstances[0].isPaused = true;
        this.isPaused = true;
    }

    /**
     * @return {Object} An Object representing this runner, but able to be converted to JSON and only containing the most necessary stuff for a report
     */
    serialize() {
        let o = {};
        this.isStopped && (o.isStopped = true);
        this.isComplete && (o.isComplete = true);

        return o;
    }

    /**
     * @return Value of the given persistent variable (can be undefined)
     */
    getPersistent(varname) {
        return this.persistent[utils.keepCaseCanonicalize(varname)];
    }

    /**
     * Sets the given persistent variable to the given value
     */
    setPersistent(varname, value) {
        this.persistent[utils.keepCaseCanonicalize(varname)] = value;
        return value;
    }

    /**
     * Set/Get a persistent variable
     */
    p(varname, value) {
        return (typeof value != 'undefined' ? this.setPersistent(varname, value) : this.getPersistent(varname));
    }

    // ***************************************
    // PRIVATE FUNCTIONS
    // Only use these internally
    // ***************************************

    /**
     * Executes all Before Everything steps, sequentially
     * @return {Promise} Promise that resolves to true if all of them passed, false if one of them failed
     */
    async runBeforeEverything() {
        let hookExecInstance = new RunInstance(this);
        for(let i = 0; i < this.tree.beforeEverything.length; i++) {
            let s = this.tree.beforeEverything[i];
            await hookExecInstance.runHookStep(s, s, null);
            if(this.consoleOutput && s.error) {
                console.log(``);
                console.log(chalk.red.bold(`Before Everything error occurred:`));
                console.log(this.formatStackTrace(s.error));
                console.log(``);
            }
            if(s.error || this.isStopped) {
                return false;
            }
        }

        return true;
    }

    /**
     * Executes all normal branches and steps, in parallel
     * @param {Number} numInstances - The maximum number of branches to run in parallel
     * @return {Promise} Promise that resolves once all of them finish running, or a stop or pause occurs
     */
    runBranches(numInstances) {
        // Spawn RunInstances, which will run in parallel
        let runInstancePromises = [];
        for(let i = 0; i < numInstances; i++) {
            let runInstance = new RunInstance(this);
            this.runInstances.push(runInstance);
            runInstancePromises.push(runInstance.run());
        }

        return Promise.all(runInstancePromises);
    }

    /**
     * Executes all After Everything steps, sequentially
     * @return {Promise} Promise that resolves once all of them finish running
     */
    async runAfterEverything() {
        let hookExecInstance = new RunInstance(this);
        for(let i = 0; i < this.tree.afterEverything.length; i++) {
            let s = this.tree.afterEverything[i];
            await hookExecInstance.runHookStep(s, s, null);
            if(this.consoleOutput && s.error) {
                console.log(``);
                console.log(chalk.red.bold(`After Everything error occurred:`));
                console.log(this.formatStackTrace(s.error));
                console.log(``);
            }
        }

        this.tree.timeEnded = new Date();
        if(this.tree.elapsed != -1) {
            this.tree.elapsed = this.tree.timeEnded - this.tree.timeStarted; // only measure elapsed if we've never been paused
        }

        this.isComplete = true;
    }

    /**
     * Injects [filename:lineNumber] into the given Error's stack trace, colors the lines, and returns it
     */
    formatStackTrace(error) {
        let stack = error.stack;
        stack = stack.replace(/\n/, `   [${error.filename}:${error.lineNumber}]\n`);

        let firstLine = stack.match(/.*/);
        if(firstLine) {
            firstLine = firstLine[0];
            stack = stack.replace(firstLine, '');
            stack = chalk.gray(stack);
            stack = chalk.red(firstLine) + stack;
        }

        return stack;
    }

    /**
     * Ending tasks, such as Run After Everything hooks
     */
    async end() {
        if(this.isStopped) {
            // don't do anything, since stop() will call runAfterEverything() immediately
        }
        else if(this.isPaused) {
            this.tree.elapsed = -1;
        }
        else {
            await this.runAfterEverything();
        }
    }

    /**
     * Starts the reporter, if there is one
     */
    async startReporter() {
        if(this.reporter) {
            await this.reporter.start();
        }
    }

    /**
     * Stops the reporter, if there is one
     */
    async stopReporter() {
        if(this.reporter) {
            await this.reporter.stop();
        }
    }
}
module.exports = Runner;
