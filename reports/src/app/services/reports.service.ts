import { Injectable, OnInit } from '@angular/core';
import { DocumentReference, DocumentSnapshot, QuerySnapshot } from '@angular/fire/firestore';
import { Observable, of, Subscription } from 'rxjs';
import { map, take, tap } from 'rxjs/operators';
import { GroupsService, Student, Group } from 'src/app/services/groups.service';
import { DatabaseService } from '../services/database.service';
import { AuthenticationService } from './authentication.service';
import { User } from '../utilities/authentication/user.model';
import { CustomService } from './custom.service';
import { sentence, SentencesService } from './sentences.service';
import { Template, TemplatesService } from './templates.service';
import { TemplateTest, Test, TestOptions, TestsService, TestVariable } from './tests.service';
import { ConsoleService } from '../admin/services/console.service';

export interface ReportTemplate {
    id: string; name: string; manager: string; templateId: string; groupId: string; lastUpdated: number;
    variables: VariableValues[]; globals: GlobalValues[]; tests: TestValues[]; names: ReportNamingConvention;
    keys: string[]; chars?: { min: number; max: number }
    reports: Report[];
}

export interface ReportNamingConvention {
  firstTime: string; otherTimes: string; startSentences: string; midSentence: string; allowRepeats: boolean;
}

export interface FBReportTemplate {
    id: string; name: string; manager: string;  templateId: string; groupId: string;
    variables: any; lastUpdated: number; globals: any; tests: any; names: ReportNamingConvention;
    keys: string[]; chars?: { min: number; max: number }
    reports: Report[];
}

export interface Report {
    userId: string, user: Student; templateId: string; report: string; generated: number[];
}

export interface GlobalValues {
    identifier: string; value: string; options: string[], tooltip?: string
}

export interface VariableValues {
    identifier: string, key: string, value: string, options: string[], tooltip?: string, optional: boolean
}

export interface TestValues {
    name: string, identifier: string, settings?: { name: string; value: TestOptions; options: TestOptions[] }, values: TestIndividualValue[]
}

export interface TestIndividualValue {
    identifier: string; name: string; key: string; value: string, options: string[]
}

@Injectable({
  providedIn: 'root'
})

export class ReportsService {

    reports: ReportTemplate[] = [];
    user: User;

    constructor(
        private db: DatabaseService,
        private sentenceService: SentencesService,
        private testsService: TestsService,
        private groupsService: GroupsService,
        private templateService: TemplatesService,
        private auth: AuthenticationService,
        private customService: CustomService
    ) {
    }

    /**
     * Retrieves all user reports from the database...
     * todo: add local storage;
     * @returns
     */
    getReports(forcedFromDatabase: boolean = false, uid?: string): Observable<ReportTemplate[]> {
        this.reports = [];

        // if the data exists locally, grab it!
        if(localStorage.getItem('reports-data') !== null && forcedFromDatabase === false) {
            // retrieve the data from local storage and parse it into the templates data...
            console.log(JSON.parse(localStorage.getItem('reports-data')));
            this.reports = JSON.parse(localStorage.getItem('reports-data'));

            // set the data on the display
            // and return the data array...
            return of(this.reports).pipe(take(1), tap((returnData: ReportTemplate[]) => {
                // set the current number of reports...
                this.customService.setNumberOfReports(returnData.length);
                // calculate recent reports...
                this.customService.setNumberOfReportsGenerated(this.calculateRecentReports(returnData));
                console.log(returnData);
                return returnData;
            }));
        } else {
            // get from the DB
            const userId: string = uid ?? undefined;

            return this.db.getReports(userId).pipe(take(1), map((queryResults: QuerySnapshot<ReportTemplate>) => {
                let reportsNew: ReportTemplate[] = [];
                // build the rpeorts...
                queryResults.forEach((report: DocumentSnapshot<ReportTemplate>) => {
                    let newReport: ReportTemplate = this.convertBackToArrays(report.data());
                    // add the id...
                    newReport.id = report.id;
                    // rebuild the arrays :(
                    let rebuilt: ReportTemplate = this.convertBackToArrays(newReport);
                    // and push tot he main array
                    // reportsNew.push(newReport);
                    reportsNew.push(rebuilt);
                })
                // set the variable
                this.reports = reportsNew;
                // calculate recent reports...
                this.customService.setNumberOfReportsGenerated(this.calculateRecentReports(reportsNew));
                // set the local sotrage
                this.setlocalStorage(this.reports);
                return reportsNew;
            }, error => {
                console.log(`Error: ${error}`);
            }))
        }
    }

    /**
     * stores the data in the local storage
     *
     * @param reports
     */
    setlocalStorage(reports: ReportTemplate[]): void {
        // set the number of reports...
        this.customService.setNumberOfReports(reports.length);
        localStorage.setItem('reports-data', JSON.stringify(reports));
    }

    /**
     * Gets an individual report.
     * @param id
     * @returns
     */
    getReport(id: string): Observable<ReportTemplate> {
        if(this.reports.length === 0) {
            // load the reports into the menu
            return this.getReports().pipe(take(1), map((data: ReportTemplate[]) => {
                this.reports = data;
                // return the correct report.
                return this.returnReport(id);
              }, error => {
                console.log(`Error: ${error}`);
              }))
            } else {
            return of(this.returnReport(id));
        }
    }

    /**
     * Returns a single report from the database...
     * @param id
     * @returns
     */
    returnReport(id: string): ReportTemplate {
        let reportIndex = this.reports.findIndex((repo: ReportTemplate) => repo.id === id);
        // and return
        if(reportIndex !== -1) {
            return this.reports[reportIndex];
        }
    }

    generateVariables(template: Template): [GlobalValues[], VariableValues[]] {
        let globals: GlobalValues[] = [];
        let genderVariable: VariableValues = { identifier: "Gender", key: "", value: "", optional: true, options: ["Female", "Male", "Plural/Other"], tooltip: "Optional: Do not assign this to a column and your reports will be gender neutral."};
        let variables: VariableValues[] = [genderVariable];
        let splitRegex: RegExp = new RegExp('\\$\\{(.*?)\\}\\$', 'g');
        let duplicates: string[] = [];

        let testOptions = this.sentenceService.newTestSentenceOptionCreatorSelectFlatArray(template.template);

        let optionsRegex: RegExp = new RegExp('\\[(.*?)\\]', 'g');
        let noHitMax: number = 2500;

        // look through the template for any globals that might be needed...
        template.template.forEach((section: string[]) => {
            // loop through each potential sentence to check for variables...
            // no hit counts to noHitMax and if no new variables are detected in that period then it skips trying to rest.
            // this is to speed up huge templates!
            let noHitIterations: number = 0;

            testOptions.forEach((option: string, index: number) => {

                if(noHitIterations < noHitMax) {
                    let typeMatches: RegExpExecArray;
                    // get the values form the sentence that are between ${brackets}$ and put them in values
                    while(typeMatches = splitRegex.exec(option)) {

                        // doesnt work for g|Time Period[semester,term] on one occasion, but on the rest of the occasions its fine...
                        let exists = duplicates.findIndex((temp: string) => temp === typeMatches[1]);

                        // test if its already been identified and if not, push onto the array
                        if(exists === -1) {
                            // duplicates array used to ensure no doubles... doesnt work for time period :S
                            // console.log(index, typeMatches[1], option, typeMatches);
                            duplicates.push(typeMatches[1]);

                            // find if its a global or variable
                            let data: string[] = typeMatches[1].split('|');

                            // get any options options (surrounded by [ ] separated by ,)
                            let optionsMatches: RegExpExecArray;
                            let options: string[] = [];

                            // and get the options, if any...
                            while(optionsMatches = optionsRegex.exec(data[1])) {
                                options = optionsMatches[1].split(',');
                            }

                            // finally build the variable to put into the reports array
                            let newVariable: GlobalValues | VariableValues;
                            let identifier: string = data.length === 2 ? data[1].split('[')[0] : data[0];

                            switch(data[0]) {
                                case 'g':
                                    // this is a global values
                                    newVariable = { identifier: identifier, value: "", options: options, optional: false};
                                    globals.push(newVariable);
                                    break;
                                case 'v':
                                    // this is a variable value (assume no |, or should I add v|??)
                                    newVariable = { identifier: identifier, key: "", value: "", options: options, optional: false};
                                    variables.push(newVariable);
                                    break;
                            }

                            noHitIterations = 0;

                        } else { noHitIterations++; }
                    }
                }
            })

        })

        // return both arrays...
        return [globals, variables];
    }

    generateTests(template: Template): TestValues[] {
        let testVals: TestValues[] = [];

        template.template.forEach((template: string[]) => {
            // get the sentence data
            let testData: [sentence[]][] = this.sentenceService.getCompoundSentenceData(template, true, ['tests']);
            // loops over all options (need data for it all!)
            testData.forEach((individualOption: [sentence[]]) => {
                // and iterate
                individualOption.forEach((temp: sentence[]) => {
                    // iterate over the results... again!!
                    temp.forEach((templateInfo: sentence) => {
                        // if tests exist...
                        if(templateInfo.tests) {

                            templateInfo.tests.forEach((test: TemplateTest) => {
                                // check if this test is already added
                                const testIndex = testVals.findIndex((t: TestValues) => test.identifier === t.identifier);
                                // if not there, add it...
                                if(testIndex === -1) {

                                    // get the test we are intersted in...
                                    let newTest: Test = this.testsService.getTest(test.identifier);
                                    let testValues: TestValues = {name: test.name, identifier: test.identifier, values: []};

                                    // if default settings are required then set those up here...
                                    if("settings" in newTest) {
                                        let settings: { name: string; value: TestOptions; options: TestOptions[] } =
                                        {
                                            name: newTest.settings.name,
                                            value: { name: "", options: {}},
                                            options: newTest.settings.options
                                        }
                                        // default options apply...
                                        testValues.settings = settings;
                                    }

                                    let testOptions: string[];

                                    if(newTest.settings.options.length === 1) {
                                        testOptions = Object.values(newTest.settings.options[0].options);
                                    } else {
                                        testOptions = newTest.test.options;
                                    }

                                    // make an array to return...
                                    // iterate over the variables imn the test...
                                    newTest.variables.forEach((test: TestVariable) => {
                                        // add the new test to the testvalues array...
                                        testValues.values.push(
                                            {
                                                identifier: test.identifier,
                                                name: test.name,
                                                key: "",
                                                value: "",
                                                options: testOptions ? testOptions : []
                                            }
                                        )
                                    })

                                    testVals.push(testValues);
                                } // else already added
                            })
                        }
                    })
                })
            })
        })

        // and return lol :(
        return testVals;
    }

    // database functions

    /**
     * Updates the report object in the database...
     * @param report
     * @param reportId
     * @returns
     */
    updateReport(report: ReportTemplate, reportId: string): Observable<boolean> {
        // first convert the variables into maps so firebase supports the data type...
        // ALL TYPE HERE IS NULL, SINGLE FUNCTIONS
        // DO NOT USE OUTSIDE OF THIS...
        let reportCopyForFirebase = JSON.parse(JSON.stringify(report));

        let newTests = this.convertTestValuesToObjectArray(reportCopyForFirebase.tests);
        let newGlobals = this.convertGlobalValuesToObjectArray(reportCopyForFirebase.globals);
        let newVariables = this.convertVariableValuesToObjectArray(reportCopyForFirebase.variables);
        // let newReports = this.convertTemplateRouteToObjectArray(reportCopyForFirebase.reports);

        reportCopyForFirebase.globals = newGlobals;
        reportCopyForFirebase.variables = newVariables;
        reportCopyForFirebase.tests = newTests;
        // reportCopyForFirebase.reports = newReports;

        console.log(reportCopyForFirebase);

        // call the database function and return true if it succeeds and false if it fails...
        return this.db.updateReport(reportCopyForFirebase, reportId).pipe(take(1), tap(() => {
            // success
            // update the reports structure...
            let reportsContainerId: number = this.reports.findIndex((temp: ReportTemplate) => temp.id === reportId);
            // and set the data based upon the result and then update local storage....
            if(reportsContainerId === -1) {
                // this report isnt on the reports object for some reason, add it...
                this.reports.push(report);
            } else {
                // found it, modify...
                this.reports[reportsContainerId] = report;
            }
            this.setlocalStorage(this.reports);

            return true;
        }, error => {
            console.log(`Error: ${error}`);
            return false;
        }));

    }

    /**
     * Deletes a report from the database...
     * @param id
     * @returns
     */
    deleteReport(id: string): Observable<boolean> {
        return this.db.deleteReport(id).pipe(take(1), tap(() => {
            // remove from the local storage also..
            let repoIndex: number = this.reports.findIndex((temp: ReportTemplate) => temp.id === id);

            if(repoIndex !== -1) {
                // delete from the db, doesnt inform the caller of the error though and it will stay in local database.
                this.reports.splice(repoIndex, 1);
                this.setlocalStorage(this.reports);
            }
            return true;
        }, error => {
            console.log(`Error: ${error}`);
            return false;
        }));
    }

    duplicateReport(reportToDuplicate: ReportTemplate): Observable<any> {

        reportToDuplicate.name = 'Duplicate of ' + reportToDuplicate.name;
        reportToDuplicate.id = "";

        // and add to the db...
        return this.db.addNewReport(reportToDuplicate).pipe(take(1), tap({
            next: (res: DocumentReference<string>) => {
                reportToDuplicate.id = res.id;
                // and add to the common reports list.
                this.reports.push(reportToDuplicate);
                this.setlocalStorage(this.reports);
                return res.id;
            },
            error: (error) => {
                console.log("Could not duplicate report because of: " + error);
            }
        }));
    }

    /**
     * Create a new report object in the database, get the id...
     * @param report
     * @returns
     */
    createReport(report: ReportTemplate): Observable<DocumentReference> {
         // first convert the variables into maps so firebase supports the data type...
        // ALL TYPE HERE IS NULL, SINGLE FUNCTIONS
        // DO NOT USE OUTSIDE OF THIS...
        let reportCopyForFirebase = JSON.parse(JSON.stringify(report));

        let newTests = this.convertTestValuesToObjectArray(reportCopyForFirebase.tests);
        let newGlobals = this.convertGlobalValuesToObjectArray(reportCopyForFirebase.globals);
        let newVariables = this.convertVariableValuesToObjectArray(reportCopyForFirebase.variables);
        // let newReports = this.convertTemplateRouteToObjectArray(reportCopyForFirebase.reports);

        reportCopyForFirebase.globals = newGlobals;
        reportCopyForFirebase.variables = newVariables;
        reportCopyForFirebase.tests = newTests;
        // reportCopyForFirebase.reports = newReports;

        console.log(reportCopyForFirebase);

        // return the observable///
        return this.db.addNewReport(reportCopyForFirebase).pipe(take(1), tap((res: DocumentReference) => {
            // success
            report.id = res.id;
            // add to the other reports.. and update local storage...
            this.reports.push(report);
            this.setlocalStorage(this.reports);
        }, error => {
            console.log(`Error: ${error}`);
            return false;
        }))
    }


    // firebase multidimenional support fucntions :(

    /**
     * Ridiculous multidimensional support sheninigans...
     * @param report
     * @returns
     */
    convertBackToArrays(report: FBReportTemplate): ReportTemplate {
        // do the template arrays first...
        // let templateArray = Object.values(report.reports[0].template.template);
        // let newTemplateArray: [string[]] = [[]];
        // // and sub routes...
        // templateArray.forEach((route: {}, i: number) => {
        //     let newRoute: string[] = Object.values(route);
        //     if(i === 0) {
        //         newTemplateArray[0] = newRoute;
        //     } else {
        //         newTemplateArray.push(newRoute);
        //     }
        // })
        // // place back onto the users...
        // report.reports.forEach((temp: Report) => {
        //     temp.template.template = newTemplateArray;
        // });


        // VARIABLES....
        let newVariables: VariableValues[] = Object.values(report.variables);

        newVariables.forEach((usrVariable: VariableValues, i: number) => {
            let varOptions: string[] = Object.values(usrVariable.options);
            newVariables[i].options = varOptions;
        });

        // Globals....
        let newGlobals: GlobalValues[] = Object.values(report.globals);

        newGlobals.forEach((usrGlobal: GlobalValues, i: number) => {
            let varOptions: string[] = Object.values(usrGlobal.options);
            newGlobals[i].options = varOptions;
        });

        // now do the tests...
        let testsObject: TestValues[] = Object.values(report.tests);

        testsObject.forEach((test: TestValues, i: number) => {

            let valuesArray: TestIndividualValue[] = Object.values(test.values);

            valuesArray.forEach((individual: TestIndividualValue, s: number) => {
                let optionsArray: string[] = Object.values(individual.options);
                // valuesArray[s].values[s].options = optionsArray;
                valuesArray[s].options = optionsArray;
            })

            test.values = valuesArray;
        });

        // rebuild the report...
        let newReport: ReportTemplate = {
            name: report.name,
            groupId: report.groupId,
            templateId: report.templateId,
            id: report.id,
            manager: report.manager,
            variables: newVariables,
            globals: newGlobals,
            tests: testsObject,
            names: report.names,
            keys: report.keys,
            reports: report.reports,
            lastUpdated: report.lastUpdated
        }

        return newReport;
    }

    /**
     * The point of this is to convert the entirety of the tests array into an object
     *
     * This is aid its storage on firebase which does not support multidimensional arrays.
     *
     * @param tests
     * @returns
     */
    convertTestValuesToObjectArray(tests: TestValues[]): any {
        let returnObject: any = {};
        // iterate over all of the tests
        // use of the any object here liberally used to reduce type errors haxxily and to prevent the need
        // for a bunch of other objects/interfaces which will not use used outside of this function.
        tests.forEach((test: any, i: number) => {
            let valuesObject: any = {};
            // iterate over all of the tests...
            test.values.forEach((testValue: any, s: number) => {
                let testOptions: {} = {};
                testValue.options.forEach((opt: string, t: number) => {
                    testOptions[t] = opt;
                })
                testValue.options = testOptions;
                valuesObject[s] = testValue;
            })
            test.values = valuesObject;
            returnObject[i] = test;
        })
        return returnObject;
    }

    convertGlobalValuesToObjectArray(globals: GlobalValues[]): any {
        let returnObject: any = {};

        globals.forEach((global: any, i: number) => {
            let globalOptions: {} = {};

            global.options.forEach((globalValue: any, s: number) => {
                globalOptions[s] = globalValue;
            })
            global.options = globalOptions;
            returnObject[i] = global;
        })
        return returnObject;
    }

    convertVariableValuesToObjectArray(variables: VariableValues[]): any {
        let returnObject: any = {};

        variables.forEach((variables: any, i: number) => {
            let variablesOptions: {} = {};

            variables.options.forEach((variablesValue: any, s: number) => {
                variablesOptions[s] = variablesValue;
            })
            variables.options = variablesOptions;
            returnObject[i] = variables;
        })
        return returnObject;
    }

    // convertTemplateRouteToObjectArray(report: Report[]): any {
    //     let returnObject: any[] = [...report];
    //     // get a single template, assume its the same for everyone at this point

    //     let singleTemplate: any = report[0].template.template;
    //     let singleReturn: {} = {};
    //     singleTemplate.forEach((temp: any, i: number) => {
    //         let route: {} = {};
    //         temp.forEach((option: string, s: number) => {
    //             route[s] = option;
    //         })
    //         temp = route;
    //         singleReturn[i] = temp;
    //     })
    //     // then place this back onto the reports...
    //     returnObject.forEach((rep: any) => {
    //         rep.template.template = singleReturn;
    //     })
    //     return returnObject;
    // }

    /**
     * REPORT GENERATION
     */
    testExecutability(reportdocument: ReportTemplate): boolean {
        let execute: { global: boolean, variables: boolean, tests: boolean} = { global: true, variables: true, tests: true};
        // check global values have been set
        reportdocument.globals.every((global: GlobalValues) => {
            execute.global = (global.value === "" ? false : true);
            return (execute.global === true) ? true : false;
        })
        // check variables have a key assigned to them
        reportdocument.variables.every((variable: VariableValues) => {
            execute.variables = (variable.key === "" ? false : true);
            return (execute.variables === true) ? true : false;
        })
        reportdocument.tests.forEach((test: TestValues) => {
            // each variable one ach TEST needs a key
            test.values.every((test: TestIndividualValue) => {
                execute.tests = (test.key === "" ? false : true);
                return (execute.tests === true ?  true : false);
            })
        })

        // if any are false this will return false;
        return (execute.global && execute.variables && execute.tests);
    }

    /**
     * Takes a report documnet and converts all reports into readable progress reports.
     * @param reportDocument
     * @returns
     */
    generateBatchReports(reportDocument: ReportTemplate): ReportTemplate {
        // this is where the magic happens :-)
        let globalVariables: GlobalValues[] = reportDocument.globals;
        let variableVariables: VariableValues[] = reportDocument.variables;
        let testVariables: TestValues[] = reportDocument.tests;
        let namesOptions: ReportNamingConvention = reportDocument.names;

        // ITERATE Over all reports...
        reportDocument.reports.forEach((individualReport: Report) => {
            // generate a report for this user...
            individualReport.report = this.generateIndividualReports(individualReport, globalVariables, variableVariables, testVariables, namesOptions);
            // if the report is valid then update the reports generated counter...
            if(individualReport.report !== "") {
                individualReport.generated ? individualReport.generated.push(new Date().getTime()) : individualReport.generated = [new Date().getTime()];
                // increment the reports generated...
                this.customService.incrementNumberOfReportsGenerated(1);
            }
        })

        // return the original modified reportdocument.
        return reportDocument;
    }

    /**
     * Takes a single report interface object and uses data from the template to generate a report...
     * gender defaults to they/them/their if no gender is submitted.
     * @param report
     * @param reportDocument
     * @returns
     */
    generateIndividualReports(report: Report, globals: GlobalValues[], variables: VariableValues[], tests: TestValues[], names: ReportNamingConvention): string {

        // check if we are allowed to generate any more reports, and if not return now...
        if(!this.customService.allowReportGenerate()) {
            return "";
        }

        // get the gender if it exists...
        let genderIndex: number = variables.findIndex((test: VariableValues) => test.identifier === "Gender");
        let gender: "Male" | "Female" | "Plural/Other" | "m" | "f" | "p" | "M" | "F" | "P" = "Plural/Other";
        // if it exists then reassign else leave it as p (plural!)
        if(genderIndex !== -1) {
            gender = report.user.data[variables[genderIndex].key];
        }

        // first we need a sentence structure generated for this template.
        let template: Template = this.templateService.getTemplate(report.templateId);
        let minCharacters: number = template.characters.min;
        let maxCharacters: number = template.characters.max;
        let sentenceOptionsTested: string[] = this.sentenceService.newTestSentenceOptionCreatorSelectSentences(template.template, report.user, tests);

        // if we have any results...
        if(sentenceOptionsTested.length > 0) {

            let finalSelections: string[] = []; // these are the reports that will fit the bill...
            let notSelected: string[] = []; // these are the reports that will not fit the bill...

            // gotta do all the reports to see which fit the size boundaires... this might hurt computationally but the subs need to be made first to check length...
            sentenceOptionsTested.forEach((reportIteration: string) => {
            // now sub in values
                globals.forEach((global: GlobalValues) => { reportIteration = this.valuesSubstitute(reportIteration, 'g\\|'+global.identifier, global.value.trim()); })
                variables.forEach((variable: VariableValues) => { reportIteration = this.valuesSubstitute(reportIteration, 'v\\|'+variable.identifier, report.user.data[variable.key]); })
                reportIteration = this.substituteNames(reportIteration, names, report.user.data, gender);
                reportIteration = this.substitutions(reportIteration, gender);
                // if its the right size add to the final array to choose from...
                if(reportIteration.length >= minCharacters && reportIteration.length <= maxCharacters) {
                    // its the right size, add to the array
                    finalSelections.push(reportIteration);
                } else {
                    // its incorrect, so store it just in acse nothing else works...
                    notSelected.push(reportIteration);
                }
            })

            let randomValueForSelect: number;
            let returnReport: string;

            // test if any appropriate reports are availazble based upon character size, and if not find the closets in the not selected reports...
            if(finalSelections.length === 0) {
                let closestIndex: number = 0;
                let closestNumber: number = 10000;
                let avg: number = (maxCharacters + minCharacters) * 0.5;

                // console.log("unable to meet character length specs: min " +minCharacters+ " / max: " + maxCharacters+ " / avg:" + avg);
                // iterate over all reports unused...
                notSelected.forEach((report: string, index: number) => {
                    let distance: number = Math.abs(report.length - avg);
                    // console.log(distance);
                    // if its closer than the current closest replace the index...
                    if(distance < closestNumber) {
                        closestIndex = index;
                        closestNumber = distance;
                    }
                })
                returnReport = notSelected[closestIndex];
            } else {
                randomValueForSelect = Math.floor(Math.random() * finalSelections.length);
                returnReport = finalSelections[randomValueForSelect];
            }
            // return selected sentence
            return returnReport;
        } else {
            return "";
        }
    }

    /**
     * Runs the grammar check functions.
     * Sometimes this is not going to be super smart.
     * @param report
     * @returns
     */
    substitutions(report: string, gender: "Male" | "Female" | "Plural/Other" | "m" | "f" | "p" | "M" | "F" | "P"): string {
        report = this.sentenceCase(report);
        // gender transform...
        report = this.genderConversion(report, gender);
        // optional words - must come after grammar check as the style of writing i the same and pickaword will choos eat random
        report = this.anOrA(report);   // must come before pickaword as the syntax for selection is the same, and if pick came first it will select anora
        report = this.pickAWord(report); // this should be the last of the [] notations as it selects the worths within the brackets as opposed to an action based upon the content [AnOrA], PICK An or A depending on the next letter for example.
        // finally remove the whitespace;
        report = this.removeWhiteSpace(report);
        report = this.repeatCharacterRemoval2(report);
        return report;
    }

    /**
     * Substitutes variables into the text...
     * @param report
     * @param substitution
     * @param value
     * @returns
     */
    valuesSubstitute(report: string, substitution: string, value: string): string {
        // first if there is a (notation) then escape it so it works properly...
        substitution = substitution.replace(/[()]/g, '\\$&');
        // then get to replacing text!
        let strReplace = new RegExp('\\$\\{('+substitution+')+(\\[.*?])?\\}\\$', 'gi');
        let regExData: string[];

        while((regExData = strReplace.exec(report)) !== null) {
            report = report.replace(regExData[0], value);
            strReplace.lastIndex = 0;
        }

        return report;
    }

    /**
     * Substitutes names into the report based upon naming conventions selected by the user
     * This function will
     * - Split into sentences and change the first value of ${Name}$ to whatever is required.
     * - ... and subsequent ones to whatever is required, or allowed.
     *
     * @param report
     * @param namingConventions
     * @param userData
     * @returns
     */
    substituteNames(report: string, namingConventions: ReportNamingConvention, userData: {}, gender: "Male" | "Female" | "Plural/Other" | "m" | "f" | "p" | "M" | "F" | "P" = "p"): string {

      let regEx: RegExp = new RegExp('\'(.*?)\'', 'gi');
      let firstInstance: Set<string> = new Set([...namingConventions.firstTime.split(regEx)].filter((str: string) => str !== ''));
      let otherInstance: Set<string> = new Set([...namingConventions.otherTimes.split(regEx)].filter((str: string) => str !== ''));

      // for the first incidence select as appropriate and replace...
      let firstReplacement: string = '';
      let subsequentReplacement: string = '';

      // generate the text for both the first and subsequent appearances of the name
      firstInstance.forEach((str: string) => { if(userData[str]) { firstReplacement += userData[str]; } else { firstReplacement += str; } });
      otherInstance.forEach((str: string) => { if(userData[str]) { subsequentReplacement += userData[str]; } else { subsequentReplacement += str; } });

      // change only the first instance of tghe name
      report = report.replace('${Name||//}$', firstReplacement);

      // split into sentences....
      let sentences: string[] = report.split('.');
      const replaceRegex: RegExp = new RegExp('\\$\\{(Name\\|(.*?)\\|(.*?)/(.*?)/(.*?))+(\\[.*?])?\\}\\$', 'gi');

      let genderUnique: string = gender.toLowerCase(); // default to plural
      let genderIndex: number = (genderUnique === ("male" || "m") ? 0 : genderUnique === ("female" || "f") ? 1 : 2);

      for(let i = 0 ; i < sentences.length ; i++) {

        let regexData: string[];
        let nameUsed: boolean = false;

        // loops over ewach incidence of the regex being found...
        while((regexData = replaceRegex.exec(sentences[i])) !== null) {

          let subReplacement: string = subsequentReplacement + (regexData[2] !== '' ? (regexData[2].charAt(0) === '*' ? `${regexData[2].substring(1)}` : ` ${regexData[2]}`) : '')

          // if i is 0 this is the first sentence and has been dealt with.
          // it is isnt 0 then deal witht he first occurence of the name in the sentence
          if(i !== 0) {
            switch(namingConventions.startSentences.toLowerCase()) {
              case 'name': sentences[i] = sentences[i].replace(regexData[0], subReplacement); nameUsed = true; break;
              case 'gender': sentences[i] = sentences[i].replace(regexData[0], regexData[genderIndex + 3]);  break;
              case 'either': sentences[i] = sentences[i].replace(regexData[0], Math.random() < 0.5 ? subReplacement : regexData[genderIndex + 3]); break;
            }
          }

          // if i is 0 this is the first sentences[i] and has been dealt with.
          // it is isnt 0 then deal witht he first occurence of the name in the sentences[i]
          switch(namingConventions.midSentence.toLowerCase()) {
            case 'name': {
              // repeats of using name may or may not be allowed...
              if(namingConventions.allowRepeats || !nameUsed) {
                sentences[i] = sentences[i].replace(regexData[0], subReplacement); nameUsed = true;
              } else {
                sentences[i] = sentences[i].replace(regexData[0], regexData[genderIndex + 3]);
              }
              break;
            }
            case 'either': {
              let choice: number = Math.random();

              // repeats of using name may or may not be allowed...
              if((namingConventions.allowRepeats || !nameUsed) && choice >= 0.5) {
                sentences[i] = sentences[i].replace(regexData[0], subReplacement);
                nameUsed = true;
              } else {
                sentences[i] = sentences[i].replace(regexData[0], regexData[genderIndex + 3]);
              }
              break;
            }
            case 'gender': sentences[i] = sentences[i].replace(regexData[0], regexData[genderIndex + 3]);  break;
          }

        }

      }

      return sentences.join('. ');
    }

    /**
     * Dea with gender values...
     * @param report
     * @param gender
     * @returns
     */
    genderConversion(report: string, gender: "Male" | "Female" | "Plural/Other" | "m" | "f" | "p" | "M" | "F" | "P" = "p", leadWord: string = 'gn'): string {
        let genderUnique: string = gender.toLowerCase(); // default to plural
        let genderIndex: number = (genderUnique === ("male" || "m") ? 0 : genderUnique === ("female" || "f") ? 1 : 2);
        let strReplace = new RegExp('\\$\\{('+leadWord+'\\|(.*?)/(.*?)/(.*?))+(\\[.*?])?\\}\\$', 'gi');

        let regexData: string[];

        while((regexData = strReplace.exec(report)) !== null) {
            report = report.replace(regexData[0], regexData[2+genderIndex]);
            strReplace.lastIndex = 0;
        }

        // return
        return report;
    }

    /**
     * If multiple optionsal words exist in a bracket notation [this/that]
     * then this function will randomly select one of the words.
     * @param report
     * @returns
     */
    pickAWord(report: string): string {
        let strReplace = new RegExp('\\[(.*?)\\]', 'gi');
        let regExData: string[];

        while((regExData = strReplace.exec(report)) !== null) {
            // recursive options support - only one level deep allowed otherwise things get too complex
            let options: string[] = regExData[1].split('/');
            let randomValue: number = Math.floor(Math.random() * options.length);
            report = report.replace(regExData[0], options[randomValue]);
            strReplace.lastIndex = 0;
        }

        return report;
    }

    /**
     * Is it an AN or an A.
     * RULES: If the next word is a CONSONANT then its A, if its a VOWEL then its AN.
     * 90% of the time this will be followed by a grade!
     * @param report
     * @returns
     */
    anOrA(report: string): string {
        let strReplace = new RegExp('\\[AnOrA\\]+(.*)?', 'gi');
        let regExData: string[];

        while((regExData = strReplace.exec(report)) !== null) {
            let choice: string = (regExData[1].trimStart())[0].toLowerCase() === ("a"||"e"||"i"||"o"||"u") || !isNaN(+regExData[1].trimStart()) ? "an" : "a";
            let newStr: string = regExData[0].replace("[AnOrA]", choice);
            report = report.replace(regExData[0], newStr);
            strReplace.lastIndex = 0;
        }
        return report;
    }

    /**
     * Tidies up any sentence case issues.
     * - Put a . at the end if there isnt one.
     * - Put a space after a . and capitalise the first letter
     * - Capitalise the first letter of the whoole thing.
     *
     * @param report
     * @returns
     */
    sentenceCase(report: string): string {
        let uppered: string = report;
        let result: string = "";
        let sentences: string[] = uppered.split('.');
        // each sentence should have a capital letter...
        sentences.forEach((sentence: string, i: number) => {
            i !== 0 ? result += " " : null;
            result += (sentence.charAt(0).toUpperCase() + sentence.slice(1)).trimLeft() + '.';
        })
        // return
        return result;
    }

    /**
     * Removes whitespace at the start and end of the text
     * strips any double whitespaces
     * removes whitespace right before a , or a .
     * @param report
     * @returns
     */
    removeWhiteSpace(report: string): string {
        // get rid of multiple whitespaces...
        report = report.trim().replace(/\s\s+/g, '');
        // ensure there is also a whitespace after a fullstop or a comma...
        let sentences: string[] = report.split('.');

        // remove all whitespace within the sentences, at the start and end of the . and , structures...
        sentences.forEach((sentence: string) => {
            // then split into commas...
            let sections: string[] = sentence.split(',');

            sections.forEach((section: string, i: number) => {
                section.trim();
                // if its the end of the sentence use a full stop, optherwise use a comma and space...
            })
        })        // recombined.replace(' +/gi', ' ');

        return report;
    }

    repeatCharacterRemoval2(report: string): string {
        let regExComma: RegExp = new RegExp(/,[\s]{1,},/gm);
        let regExFS: RegExp = new RegExp(/\.[\s]{1,}\./gm);

        let regExString: string[];

        while((regExString = regExComma.exec(report)) !== null) { report = report.replace(regExString[0], ', '); }
        while((regExString = regExFS.exec(report)) !== null) { report = report.replace(regExString[0], '.'); regExFS.lastIndex = 0; }

        return report;
    }

    repeatCharacterRemoval(report: string): string {
        let chars: string[] = [',','.'];

        chars.forEach((char: string) => {

            let regEx: RegExp = new RegExp('['+char+']{2,10}', 'gi');
            let regExString: string[];

            while((regExString = regEx.exec(report)) !== null) {
                report = report.replace(regExString[0], regExString[0].charAt(0));
                regEx.lastIndex = 0;
            }


        })

        return report;
    }

    /**
     * Calculates all reports generated over a time period..
     * @param reportSet
     * @returns
     */
    calculateRecentReports(reportSet: ReportTemplate[]): number {
        // calculate recent reports...
        let totalRecentReports: number = 0;
        const timeLimit: number = new Date().getTime() - (this.customService.getNumberOfReportsGeneratedTimeFrame() * 1000 * 60 * 60 * 24);
        // iterate over all reports...
        reportSet.forEach((report: ReportTemplate) => {
            // for each report find out how many were generated within the time limit.
            for(let i = 0; i < report.reports.length; i++) {
                let repo: Report = report.reports[i];
                if(repo.hasOwnProperty('generated')) {
                    // and if its recent increment the counter, filter out all the expired timestamps...
                    repo.generated = repo.generated.filter((timestamp: number) => timestamp > timeLimit);
                    totalRecentReports += repo.generated.length;
                }
            }
        })
        return totalRecentReports;
    }
}

