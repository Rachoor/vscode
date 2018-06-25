/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import product from 'vs/platform/node/product';

import { createDecorator } from 'vs/platform/instantiation/common/instantiation';
import { IStorageService, StorageScope } from 'vs/platform/storage/common/storage';
import { IEnvironmentService } from 'vs/platform/environment/common/environment';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';
import { ILifecycleService, LifecyclePhase } from 'vs/platform/lifecycle/common/lifecycle';

import { IRequestService } from 'vs/platform/request/node/request';

import { TPromise } from 'vs/base/common/winjs.base';
import { language } from 'vs/base/common/platform';
import { Disposable, IDisposable, dispose } from 'vs/base/common/lifecycle';
import { match } from 'vs/base/common/glob';

import { asJson } from 'vs/base/node/request';


import { IExtensionsWorkbenchService } from 'vs/workbench/parts/extensions/common/extensions';
import { ITextFileService, StateChange } from 'vs/workbench/services/textfile/common/textfiles';
import { WorkspaceStats } from 'vs/workbench/parts/stats/node/workspaceStats';
import { Emitter, Event } from 'vs/base/common/event';

// TODO:

// offline should not affect already resolved experiments - Tests needed
// should support opt-out? not for phase 1


export interface IExperimentStorageState {
	enabled: boolean;
	state: ExperimentState;
	editCount?: number;
	lastEditedDate?: string;
}

export enum ExperimentState {
	Evaluating,
	NoRun,
	Run,
	Complete
}

interface IRawExperiment {
	id: string;
	enabled?: boolean;
	condition?: {
		insidersOnly?: boolean;
		displayLanguage?: string;
		installedExtensions?: {
			excludes?: string[];
			includes?: string[];
		},
		fileEdits?: {
			filePathPattern?: string;
			workspaceIncludes?: string[];
			workspaceExcludes?: string[];
			minEditCount: number;
		},
		userProbability?: number;
		evaluateOnlyOnce?: boolean;
	};
	action?: { type: string; properties: any };
}

export interface IExperimentActionPromptProperties {
	prompt: string;
	commands: IExperimentActionPromptCommand[];
}

interface IExperimentActionPromptCommand {
	text: string;
	externalLink?: string;
	dontShowAgain?: boolean;
	curatedExtensionsKey?: string;
	curatedExtensionsList?: string[];
}

export interface IExperiment {
	id: string;
	enabled: boolean;
	state: ExperimentState;
	action?: IExperimentAction;
}

export enum ExperimentActionType {
	Custom,
	Prompt,
	AddToRecommendations
}

export interface IExperimentAction {
	type: ExperimentActionType;
	properties: any;
}

export interface IExperimentService {
	_serviceBrand: any;
	getExperimentById(id: string): TPromise<IExperiment>;
	getEligibleExperimentsByType(type: ExperimentActionType): TPromise<IExperiment[]>;
	getCuratedExtensionsList(curatedExtensionsKey: string): TPromise<string[]>;
	markAsCompleted(experimentId: string): void;

	onExperimentEnabled: Event<IExperiment>;
}

export const IExperimentService = createDecorator<IExperimentService>('experimentService');

export class ExperimentService extends Disposable implements IExperimentService {
	_serviceBrand: any;
	private _experiments: IExperiment[] = [];
	private _loadExperimentsPromise: TPromise<void>;
	private _curatedMapping = Object.create(null);
	private _disposables: IDisposable[] = [];

	private readonly _onExperimentEnabled: Emitter<IExperiment> = new Emitter<IExperiment>();

	onExperimentEnabled: Event<IExperiment> = this._onExperimentEnabled.event;
	constructor(
		@IStorageService private storageService: IStorageService,
		@IExtensionsWorkbenchService private extensionWorkbenchService: IExtensionsWorkbenchService,
		@ITextFileService private textFileService: ITextFileService,
		@IEnvironmentService private environmentService: IEnvironmentService,
		@ITelemetryService private telemetryService: ITelemetryService,
		@ILifecycleService private lifecycleService: ILifecycleService,
		@IRequestService private requestService: IRequestService
	) {
		super();

		this._loadExperimentsPromise = TPromise.wrap(this.lifecycleService.when(LifecyclePhase.Eventually)).then(() => this.loadExperiments());
	}

	public getExperimentById(id: string): TPromise<IExperiment> {
		return this._loadExperimentsPromise.then(() => {
			return this._experiments.filter(x => x.id === id)[0];
		});
	}

	public getEligibleExperimentsByType(type: ExperimentActionType): TPromise<IExperiment[]> {
		return this._loadExperimentsPromise.then(() => {
			if (type === ExperimentActionType.Custom) {
				return this._experiments.filter(x => x.enabled && x.state === ExperimentState.Run && (!x.action || x.action.type === type));
			}
			return this._experiments.filter(x => x.enabled && x.state === ExperimentState.Run && x.action && x.action.type === type);
		});
	}

	public getCuratedExtensionsList(curatedExtensionsKey: string): TPromise<string[]> {
		return this._loadExperimentsPromise.then(() => {
			for (let i = 0; i < this._experiments.length; i++) {
				if (this._experiments[i].enabled
					&& this._experiments[i].state === ExperimentState.Run
					&& this._curatedMapping[this._experiments[i].id]
					&& this._curatedMapping[this._experiments[i].id].curatedExtensionsKey === curatedExtensionsKey) {
					return this._curatedMapping[this._experiments[i].id].curatedExtensionsList;
				}
			}
			return [];
		});
	}

	public markAsCompleted(experimentId: string): void {
		const storageKey = 'experiments.' + experimentId;
		const experimentState: IExperimentStorageState = safeParse(this.storageService.get(storageKey, StorageScope.GLOBAL), {});
		experimentState.state = ExperimentState.Complete;
		this.storageService.store(storageKey, JSON.stringify(experimentState), StorageScope.GLOBAL);
	}

	protected loadExperiments(experiments?: IRawExperiment[]): TPromise<any> {
		let rawExperimentsPromise = TPromise.as(experiments || null);
		if (!experiments && product.experimentsUrl) {
			rawExperimentsPromise = this.requestService.request({ type: 'GET', url: product.experimentsUrl }).then(context => {
				if (context.res.statusCode !== 200) {
					return TPromise.as(null);
				}
				return asJson(context).then(result => {
					const experiments = Array.isArray(result['experiments']) ? result['experiments'] : [];
					const allExperimentIdsFromStorage = safeParse(this.storageService.get('allExperiments', StorageScope.GLOBAL), []);
					const enabledExperiments = experiments.filter(experiment => !!experiment.enabled).map(experiment => experiment.id.toLowerCase());
					if (Array.isArray(allExperimentIdsFromStorage)) {
						allExperimentIdsFromStorage.forEach(experiment => {
							if (enabledExperiments.indexOf(experiment) === -1) {
								this.storageService.remove('experiments.' + experiment);
							}
						});
					}
					this.storageService.store('allExperiments', JSON.stringify(enabledExperiments), StorageScope.GLOBAL);

					return experiments;
				});
			}, () => TPromise.as(null));
		}

		return rawExperimentsPromise.then(rawExperiments => {
			if (!rawExperiments) {
				const allExperimentIdsFromStorage = safeParse(this.storageService.get('allExperiments', StorageScope.GLOBAL), []);
				if (Array.isArray(allExperimentIdsFromStorage)) {
					allExperimentIdsFromStorage.forEach(experimentId => {
						const storageKey = 'experiments.' + experimentId;
						const experimentState: IExperimentStorageState = safeParse(this.storageService.get(storageKey, StorageScope.GLOBAL), null);
						if (experimentState) {
							this._experiments.push({
								id: experimentId,
								enabled: experimentState.enabled,
								state: experimentState.state
							});
						}
					});
				}
				return TPromise.as(null);
			}
			const promises = rawExperiments.map(experiment => {
				const processedExperiment: IExperiment = {
					id: experiment.id,
					enabled: !!experiment.enabled,
					state: ExperimentState.Evaluating
				};

				if (experiment.action) {
					processedExperiment.action = {
						type: ExperimentActionType[experiment.action.type] || ExperimentActionType.Custom,
						properties: experiment.action.properties
					};
					if (processedExperiment.action.type === ExperimentActionType.Prompt) {
						((<IExperimentActionPromptProperties>processedExperiment.action.properties).commands || []).forEach(x => {
							if (x.curatedExtensionsKey && Array.isArray(x.curatedExtensionsList)) {
								this._curatedMapping[experiment.id] = x;
							}
						});
					}
				}
				this._experiments.push(processedExperiment);

				const storageKey = 'experiments.' + experiment.id;
				const experimentState: IExperimentStorageState = safeParse(this.storageService.get(storageKey, StorageScope.GLOBAL), {});
				if (!experimentState.hasOwnProperty('enabled')) {
					experimentState.enabled = processedExperiment.enabled;
				}
				if (!experimentState.hasOwnProperty('state')) {
					experimentState.state = processedExperiment.enabled ? ExperimentState.Evaluating : ExperimentState.NoRun;
				} else {
					processedExperiment.state = experimentState.state;
				}

				if (processedExperiment.state !== ExperimentState.Evaluating) {
					this.storageService.store(storageKey, experimentState);
					return TPromise.as(null);
				}

				return this.shouldRunExperiment(experiment, processedExperiment).then((state: ExperimentState) => {
					experimentState.state = processedExperiment.state = state;
					this.storageService.store(storageKey, experimentState);

					if (state === ExperimentState.Run && processedExperiment.action && processedExperiment.action.type === ExperimentActionType.Prompt) {
						this._onExperimentEnabled.fire(processedExperiment);
					}
					return TPromise.as(null);
				});

			});
			return TPromise.join(promises).then(() => {
				this.telemetryService.publicLog('experiments', this._experiments);
			});
		});
	}

	private shouldRunExperiment(experiment: IRawExperiment, processedExperiment: IExperiment): TPromise<ExperimentState> {
		if (!experiment.enabled) {
			return TPromise.wrap(ExperimentState.NoRun);
		}

		if (!experiment.condition) {
			return TPromise.wrap(ExperimentState.Run);
		}

		if (this.environmentService.appQuality === 'stable' && experiment.condition.insidersOnly === true) {
			return TPromise.wrap(ExperimentState.NoRun);
		}

		if (typeof experiment.condition.displayLanguage === 'string') {
			let localeToCheck = experiment.condition.displayLanguage.toLowerCase();
			let displayLanguage = language.toLowerCase();

			if (localeToCheck !== displayLanguage) {
				const a = displayLanguage.indexOf('-');
				const b = localeToCheck.indexOf('-');
				if (a > -1) {
					displayLanguage = displayLanguage.substr(0, a);
				}
				if (b > -1) {
					localeToCheck = localeToCheck.substr(0, b);
				}
				if (displayLanguage !== localeToCheck) {
					return TPromise.wrap(ExperimentState.NoRun);
				}
			}
		}

		if (!experiment.condition.userProbability) {
			experiment.condition.userProbability = 1;
		}

		let extensionsCheckPromise = TPromise.as(true);
		if (experiment.condition.installedExtensions) {
			extensionsCheckPromise = this.extensionWorkbenchService.queryLocal().then(locals => {
				let includesCheck = true;
				let excludesCheck = true;
				if (Array.isArray(experiment.condition.installedExtensions.includes) && experiment.condition.installedExtensions.includes.length) {
					const extensionIncludes = experiment.condition.installedExtensions.includes.map(e => e.toLowerCase());
					includesCheck = locals.some(e => extensionIncludes.indexOf(e.id.toLowerCase()) > -1);
				}
				if (Array.isArray(experiment.condition.installedExtensions.excludes) && experiment.condition.installedExtensions.excludes.length) {
					const extensionExcludes = experiment.condition.installedExtensions.excludes.map(e => e.toLowerCase());
					excludesCheck = !locals.some(e => extensionExcludes.indexOf(e.id.toLowerCase()) > -1);
				}
				return includesCheck && excludesCheck;
			});
		}

		const storageKey = 'experiments.' + experiment.id;
		const experimentState: IExperimentStorageState = safeParse(this.storageService.get(storageKey, StorageScope.GLOBAL), {});

		return extensionsCheckPromise.then(success => {
			if (!success || !experiment.condition.fileEdits || typeof experiment.condition.fileEdits.minEditCount !== 'number') {
				const runExperiment = success && Math.random() < experiment.condition.userProbability;
				return runExperiment ? ExperimentState.Run : ExperimentState.NoRun;
			}

			experimentState.editCount = experimentState.editCount || 0;
			if (experimentState.editCount >= experiment.condition.fileEdits.minEditCount) {
				return ExperimentState.Run;
			}

			const onSaveHandler = this.textFileService.models.onModelsSaved(e => {
				const date = new Date().toDateString();
				const latestExperimentState: IExperimentStorageState = safeParse(this.storageService.get(storageKey, StorageScope.GLOBAL), {});
				if (latestExperimentState.state !== ExperimentState.Evaluating) {
					onSaveHandler.dispose();
					return;
				}
				e.forEach(event => {
					if (event.kind !== StateChange.SAVED
						|| latestExperimentState.state !== ExperimentState.Evaluating
						|| date === latestExperimentState.lastEditedDate
						|| latestExperimentState.editCount >= experiment.condition.fileEdits.minEditCount) {
						return;
					}
					let filePathCheck = true;
					let workspaceCheck = true;

					if (typeof experiment.condition.fileEdits.filePathPattern === 'string') {
						filePathCheck = match(experiment.condition.fileEdits.filePathPattern, event.resource.fsPath);
					}
					if (Array.isArray(experiment.condition.fileEdits.workspaceIncludes) && experiment.condition.fileEdits.workspaceIncludes.length) {
						workspaceCheck = experiment.condition.fileEdits.workspaceIncludes.some(x => !!WorkspaceStats.tags[x]);
					}
					if (workspaceCheck && Array.isArray(experiment.condition.fileEdits.workspaceExcludes) && experiment.condition.fileEdits.workspaceExcludes.length) {
						workspaceCheck = !experiment.condition.fileEdits.workspaceExcludes.some(x => !!WorkspaceStats.tags[x]);
					}
					if (filePathCheck && workspaceCheck) {
						latestExperimentState.editCount = (latestExperimentState.editCount || 0) + 1;
						latestExperimentState.lastEditedDate = date;
						this.storageService.store(storageKey, JSON.stringify(latestExperimentState), StorageScope.GLOBAL);
					}
				});
				if (latestExperimentState.editCount >= experiment.condition.fileEdits.minEditCount) {
					processedExperiment.state = latestExperimentState.state = Math.random() < experiment.condition.userProbability ? ExperimentState.Run : ExperimentState.NoRun;
					this.storageService.store(storageKey, JSON.stringify(latestExperimentState), StorageScope.GLOBAL);
					if (latestExperimentState.state === ExperimentState.Run && ExperimentActionType[experiment.action.type] === ExperimentActionType.Prompt) {
						this._onExperimentEnabled.fire(processedExperiment);
					}
				}
			});
			this._disposables.push(onSaveHandler);
			return ExperimentState.Evaluating;
		});
	}

	dispose() {
		this._disposables = dispose(this._disposables);
	}
}


function safeParse(text: string, defaultObject: any) {
	try {
		return JSON.parse(text);
	}
	catch (e) {
		return defaultObject;
	}
}