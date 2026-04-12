// ==UserScript==
// @name         Expensify reportInfo
// @namespace    https://github.com/Expensify/App
// @version      0.1.0
// @description  Injects window.reportInfo(reportID) at runtime for Expensify web
// @match        https://new.expensify.com/*
// @match        https://staging.new.expensify.com/*
// @match        https://dev.new.expensify.com/*
// @run-at       document-end
// @grant        none
// ==/UserScript==

function getUserscriptGlobalScope() {
    if (typeof window !== 'undefined') {
        return window;
    }

    if (typeof global !== 'undefined') {
        return global;
    }

    return {};
}

(function reportInfoUserscript(globalScope) {
    const DEFAULT_ONYX_COLLECTION_KEYS = {
        report: 'report_',
        reportActions: 'reportActions_',
        transactions: 'transactions_',
    };

    function isObject(value) {
        return typeof value === 'object' && value !== null;
    }

    function getCollectionKey(prefix, id) {
        return `${prefix}${id}`;
    }

    function getIOUTransactionIDFromAction(reportAction) {
        const originalMessage = reportAction?.originalMessage;
        if (!isObject(originalMessage)) {
            return undefined;
        }

        const transactionID = originalMessage.IOUTransactionID;
        return typeof transactionID === 'string' && transactionID ? transactionID : undefined;
    }

    function getIOUTransactionIDFromReportActions(reportActions) {
        for (const reportAction of Object.values(reportActions ?? {})) {
            const transactionID = getIOUTransactionIDFromAction(reportAction);
            if (transactionID) {
                return transactionID;
            }
        }
    }

    async function getReportEntry(reportID, getOnyxData, onyxCollectionKeys) {
        const reportKey = getCollectionKey(onyxCollectionKeys.report, reportID);
        const reportActionsKey = getCollectionKey(onyxCollectionKeys.reportActions, reportID);
        const [report, reportActions] = await Promise.all([getOnyxData(reportKey), getOnyxData(reportActionsKey)]);

        return {
            reportID,
            reportKey,
            report,
            reportActionsKey,
            reportActions,
        };
    }

    async function getAncestors(report, getOnyxData, onyxCollectionKeys) {
        const ancestors = [];
        let currentReport = report;

        while (currentReport?.parentReportID) {
            // Each ancestor lookup depends on the previous parent, so the traversal is intentionally sequential.
            // eslint-disable-next-line no-await-in-loop
            const ancestorEntry = await getReportEntry(currentReport.parentReportID, getOnyxData, onyxCollectionKeys);
            const parentReportAction = currentReport.parentReportActionID ? ancestorEntry.reportActions?.[currentReport.parentReportActionID] : undefined;

            ancestors.push({
                ...ancestorEntry,
                parentReportActionID: currentReport.parentReportActionID,
                parentReportAction,
            });

            if (!ancestorEntry.report) {
                break;
            }

            currentReport = ancestorEntry.report;
        }

        return ancestors;
    }

    async function getLinkedTransaction(report, reportActions, ancestors, getOnyxData, onyxCollectionKeys) {
        if (!report?.parentReportID || !report.parentReportActionID) {
            return undefined;
        }

        let transactionID = getIOUTransactionIDFromAction(ancestors.at(0)?.parentReportAction);
        let source = 'parentReportAction';

        if (!transactionID) {
            transactionID = getIOUTransactionIDFromReportActions(reportActions);
            source = 'reportActions';
        }

        if (!transactionID) {
            return undefined;
        }

        const transactionKey = getCollectionKey(onyxCollectionKeys.transactions, transactionID);
        const transaction = await getOnyxData(transactionKey);

        return {
            transactionID,
            transactionKey,
            transaction,
            source,
        };
    }

    async function getReportInfo(reportID, getOnyxData, onyxCollectionKeys) {
        const reportEntry = await getReportEntry(reportID, getOnyxData, onyxCollectionKeys);
        const ancestors = await getAncestors(reportEntry.report, getOnyxData, onyxCollectionKeys);
        const linkedTransaction = await getLinkedTransaction(reportEntry.report, reportEntry.reportActions, ancestors, getOnyxData, onyxCollectionKeys);

        return {
            ...reportEntry,
            ancestors,
            linkedTransaction,
        };
    }

    function createReportInfoTool({getOnyxData, onyxCollectionKeys, logger}) {
        return async (reportID) => {
            const result = await getReportInfo(reportID, getOnyxData, onyxCollectionKeys);
            logger?.(result);
            return result;
        };
    }

    function isOnyxCandidate(onyx) {
        return isObject(onyx) && (typeof onyx.get === 'function' || (typeof onyx.connectWithoutView === 'function' && typeof onyx.disconnect === 'function'));
    }

    function getOnyxFromExports(moduleExports) {
        if (!isObject(moduleExports)) {
            return undefined;
        }

        if (isOnyxCandidate(moduleExports)) {
            return moduleExports;
        }

        if (isOnyxCandidate(moduleExports.default)) {
            return moduleExports.default;
        }

        if (isOnyxCandidate(moduleExports.Z)) {
            return moduleExports.Z;
        }
    }

    function getWebpackRequire(targetWindow) {
        for (const [key, value] of Object.entries(targetWindow)) {
            if (!key.startsWith('webpackChunk') || !Array.isArray(value) || typeof value.push !== 'function') {
                continue;
            }

            let webpackRequire;
            const injectedChunk = [
                [`reportInfo-${Date.now()}`],
                {},
                (require) => {
                    webpackRequire = require;
                },
            ];

            try {
                value.push(injectedChunk);
                if (typeof value.pop === 'function') {
                    value.pop();
                }
            } catch {
                continue;
            }

            if (webpackRequire) {
                return webpackRequire;
            }
        }
    }

    function resolveOnyx(targetWindow) {
        const existingOnyx = getOnyxFromExports(targetWindow.Onyx);
        if (existingOnyx) {
            return existingOnyx;
        }

        const webpackRequire = getWebpackRequire(targetWindow);
        const cachedModules = webpackRequire?.c ?? {};

        for (const webpackModule of Object.values(cachedModules)) {
            const onyx = getOnyxFromExports(webpackModule?.exports);
            if (onyx) {
                return onyx;
            }
        }
    }

    function createOnyxGetter(onyx) {
        if (typeof onyx?.get === 'function') {
            return onyx.get.bind(onyx);
        }

        return (key) =>
            new Promise((resolve) => {
                let connection;
                let shouldDisconnectAfterConnect = false;
                const createdConnection = onyx.connectWithoutView({
                    key,
                    callback: (value) => {
                        if (typeof connection === 'undefined') {
                            shouldDisconnectAfterConnect = true;
                        } else {
                            onyx.disconnect(connection);
                        }

                        resolve(value);
                    },
                    waitForCollectionCallback: true,
                });
                connection = createdConnection;

                if (shouldDisconnectAfterConnect) {
                    onyx.disconnect(createdConnection);
                }
            });
    }

    function createLogger(targetWindow, logger) {
        if (typeof logger === 'function') {
            return logger;
        }

        return (message, payload) => {
            if (!targetWindow.console?.log) {
                return;
            }

            if (typeof payload === 'undefined') {
                targetWindow.console.log(`[reportInfo.user] ${message}`);
                return;
            }

            targetWindow.console.log(`[reportInfo.user] ${message}`, payload);
        };
    }

    async function installReportInfo(targetWindow, options = {}) {
        const target = targetWindow;
        const logger = createLogger(targetWindow, options.logger);
        const onyx = resolveOnyx(target);

        if (!onyx) {
            logger('Onyx runtime not found');
            return undefined;
        }

        const getOnyxData = createOnyxGetter(onyx);
        const reportInfo = createReportInfoTool({
            getOnyxData,
            onyxCollectionKeys: DEFAULT_ONYX_COLLECTION_KEYS,
            logger: (result) => logger('reportInfo result', result),
        });

        target.reportInfo = reportInfo;
        logger('reportInfo installed');
        return reportInfo;
    }

    async function waitForAndInstallReportInfo(targetWindow, options = {}) {
        const intervalMs = options.intervalMs ?? 1000;
        const maxAttempts = options.maxAttempts ?? 60;
        const logger = createLogger(targetWindow, options.logger);

        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
            // The next attempt depends on the result of the previous install attempt.
            // eslint-disable-next-line no-await-in-loop
            const reportInfo = await installReportInfo(targetWindow, {logger});
            if (reportInfo) {
                return reportInfo;
            }

            if (attempt < maxAttempts) {
                // eslint-disable-next-line no-await-in-loop
                await new Promise((resolve) => {
                    targetWindow.setTimeout(() => resolve(), intervalMs);
                });
            }
        }

        logger('Timed out waiting for Onyx runtime');
        return undefined;
    }

    const api = {
        createOnyxGetter,
        createReportInfoTool,
        getReportInfo,
        installReportInfo,
        resolveOnyx,
        waitForAndInstallReportInfo,
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
        return;
    }

    const rootScope = globalScope;
    rootScope.installReportInfoTampermonkey = (options) => installReportInfo(rootScope, options);
    rootScope.waitForReportInfoTampermonkey = (options) => waitForAndInstallReportInfo(rootScope, options);
    waitForAndInstallReportInfo(rootScope).catch((error) => {
        rootScope.console?.error?.('[reportInfo.user] Failed to auto-install reportInfo', error);
    });
})(getUserscriptGlobalScope());
