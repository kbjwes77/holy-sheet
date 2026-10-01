import { solutionMultipleChoiceToString } from "../../../../public/js/common/grade.mjs";
import { testAssertions } from "../../../../public/js/validate/test-validate.mjs";

/*
grid code
0 = empty
1 = blank spot
2 = row marker
3 = bubble
4 = problem index
5 = section title
6 = filled bubble
*/

const canvas_w = 850;
const canvas_h = 1100;
const margin = 25;
// Fraction of the bottom-right orientation marker bitten out as a white notch
// (its inner/top-left corner) so the detector can identify BR and auto-correct a
// 180°-rotated sheet. MUST match BR_NOTCH_FRAC in routes/apps/bubble/page-detect.mjs.
const BR_NOTCH_FRAC = 0.36;
const grid_w = 57;
const grid_h = 60;
const cell_w = (canvas_w - margin * 2) / grid_w;
const cell_h = (canvas_h - margin * 2) / grid_h;

/** @type {ClientTest} */
let test;
let grid, pages;
let testIDBinary, testIDBinaryRegion;
let allSections, allSubsections, allRegions, allQuestions;
let currentSection, isFirstOfNewSection, currentQuestionNumber;
let guideLineCoords, nextEmptyLine;
let continuousQuestionIndexing;
let headerDivider;
let xOffset, yOffset;
let draw;

class bubbleSheetRawInfo {
    constructor(identifier = "_id") {
        /** @type {string} - Test document ID */
        this.test = String(test[identifier]);
        /** @type {string} - Test type */
        this.type = test.type;

        /** @type {number} - Grid width (columns) */
        this.grid_w = grid_w;
        /** @type {number} - Grid height (rows) */
        this.grid_h = grid_h;
        /** @type {number} - Number of pages */
        this.pages = pages.length;

        this.allSections = allSections;
        this.allSubsections = allSubsections;
        this.allQuestions = allQuestions;
        this.allRegions = allRegions;
    }
}

class Question {
    constructor(parent, type, bubbleCount) {
        this.parent = parent;
        this.bubbleCount = bubbleCount;
        this.type = type;
        this.xy = null; // xy is the top leftmost part of the question space, containing an empty spot
        this.questionIndex = currentQuestionNumber + 1;
        currentQuestionNumber++;
        switch (type) {
            case 0:
                this.spaceRequired = 9 * 15; // 135
                break;
            case 1:
                this.spaceRequired = bubbleCount * 2 + 2;
                break;
        }
        allQuestions.push(this);
    }

    addToGrid(xCoord, yCoord) {
        // all questions are added chronologically
        this.xy = [xCoord, yCoord];
        setQuestionIntoGrid(this);
    }
}

function setQuestionIntoGrid(question) {
    if (question.type == 0) {
        for (let y = 0; y < 15; y++) {
            //setting area to blank squares
            for (let x = 0; x < 9; x++) {
                grid[question.xy[0] + x][question.xy[1] + y] = 1;
            }
        }

        for (let y = 4; y < 15; y++) {
            for (let x = 1; x < 9; x++) {
                if ((x + 1) % 2 == 0) {
                    //bubble first, then empty, repeat
                    grid[question.xy[0] + x][question.xy[1] + y] = 3; // bubble
                } else {
                    grid[question.xy[0] + x][question.xy[1] + y] = 1; // blank space
                }
            }
        } // empty
        grid[question.xy[0] + 3][question.xy[1] + 3] = 3; // bubble
        grid[question.xy[0] + 5][question.xy[1] + 3] = 3; // bubble
        grid[question.xy[0] + 1][question.xy[1]] = 4;

        grid[question.xy[0] + 1][question.xy[1] + 5] = 1;
    }

    if (question.type == 1) {
        grid[question.xy[0]][question.xy[1]] = 1; // blank
        grid[question.xy[0] + 1][question.xy[1]] = 4; // index
        for (let i = 2; i < question.spaceRequired; i++) {
            // fill every spot for question
            if (i > 1 && i % 2 == 0) {
                //bubble first, then empty, repeat
                grid[question.xy[0] + i][question.xy[1]] = 3; // bubble
            } else {
                grid[question.xy[0] + i][question.xy[1]] = 1; // blank space
            }
        }
    }
}

class SubsectionMultipleChoice {
    // YStart = what line the section starts on
    constructor(subsection_problems, type, choices) {
        this.parentSection = currentSection;
        this.firstQuestionIndex = currentQuestionNumber + 1;
        this.subsection_problems = subsection_problems;
        this.choices = choices;
        this.YStart = nextEmptyLine;
        this.YEnd;
        this.cols;
        this.rows;
        this.onWhichPage;
        this.cells_per_problem;

        this.problem_type = type;
        this.questionRegions = [];
        this.questions = [];
        this.Initialize();
    }

    Initialize() {
        //find space needed for all the questions
        this.cells_per_problem = this.choices * 2 + 2;
        this.cells_required = this.cells_per_problem * this.subsection_problems;
        this.rows = 0;
        this.cols = 0;

        let cols = 0,
            rows = 0,
            done = false;
        while (!done) {
            // calculate numbers of problems that can fit horizontally
            cols = 0;
            while ((cols + 1) * this.cells_per_problem < grid_w - 3) {
                cols++;
            }
            // calculate number of rows required
            rows = Math.ceil(this.subsection_problems / cols);

            const remainder = this.subsection_problems % rows;
            if (remainder == 0 || remainder >= rows / 3) {
                // no weird remainder problems
                done = true;
            } else {
                // reorganize problems again with more space between each problem
                this.cells_per_problem++;
                this.cells_required = this.cells_per_problem * this.subsection_problems;
            }
        }

        this.cols = cols;
        this.rows = rows;
        if (this.YStart + this.rows > grid_h - (headerDivider - 4)) {
            // if it goes past the page, make new page, set this at the top
            page_add();
        }

        if (isFirstOfNewSection) {
            if (currentSection.length != 0) {
                allSections.push(currentSection);
            }
            currentSection = [];
            if (!continuousQuestionIndexing) {
                currentQuestionNumber = 0;
            }
            grid[1][nextEmptyLine] = 5;
            nextEmptyLine += 2;
            isFirstOfNewSection = false;
        }

        // start adding questions
        this.YStart = nextEmptyLine;

        this.onWhichPage = pages.length;
        nextEmptyLine = this.YStart + this.rows;

        let gridPointer = [3, this.YStart];

        let questionsAdded = 0;
        for (let i = 0; i < this.cols; i++) {
            for (let k = 0; k < this.rows; k++) {
                if (questionsAdded >= this.subsection_problems) {
                    break;
                }
                let newQuestion = new Question(this, 1, this.choices);
                newQuestion.addToGrid(gridPointer[0], gridPointer[1]);
                this.questions.push(newQuestion);
                gridPointer[1] += 1;
                questionsAdded++;
            }
            if (questionsAdded >= this.subsection_problems) {
                break;
            }
            gridPointer[0] += this.cells_per_problem;
            gridPointer[1] = this.YStart;
        }
        this.YEnd = this.YStart + this.rows;

        let scanXOffset = 5;
        let scanYOffset = 0;
        // multiple choice regions (complete)
        for (let col = 0; col < this.cols - 1; col++) {
            this.questionRegions.push({
                page: this.onWhichPage,
                section: allSections.length,
                type: this.problem_type,
                choices: this.choices,
                x1: scanXOffset + col * this.cells_per_problem,
                y1: this.YStart + scanYOffset,
                x2: col * this.cells_per_problem + (this.choices - 1) * 2 + scanXOffset,
                y2: this.YEnd + scanYOffset - 1,
            });
        }

        // multiple choice regions (incomplete)
        let question_last = this.questions[this.questions.length - 1];

        this.questionRegions.push({
            page: this.onWhichPage,
            section: allSections.length,
            type: this.problem_type,
            choices: this.choices,
            x1: scanXOffset + (this.cols - 1) * this.cells_per_problem,
            y1: this.YStart + scanYOffset,
            x2: (this.cols - 1) * this.cells_per_problem + (this.choices - 1) * 2 + scanXOffset,
            y2: question_last.xy[1] + scanYOffset,
        });

        allRegions.push(...this.questionRegions);
        currentSection.push(this);
        allSubsections.push(this);
    }
}

class SubsectionOpenEnded {
    constructor(subsection_problems, type) {
        this.parentSection = currentSection;
        this.firstQuestionIndex = currentQuestionNumber + 1;
        this.sectionQuestionCount = subsection_problems;
        this.YStart = nextEmptyLine;
        this.YEnd;
        this.rows;
        this.cols;
        this.problem_type = type;
        this.onWhichPage;

        this.questionRegions = [];
        this.questions = [];

        this.Initialize();
    }

    Initialize() {
        this.cols = Math.floor((grid_w - 4) / 9); // (gridXCountPerPage - 3) is correct
        this.rows = Math.ceil(this.sectionQuestionCount / this.cols) * 16;

        if (this.YStart + this.rows > grid_h - (headerDivider - 4)) {
            page_add();
        }

        if (isFirstOfNewSection) {
            if (currentSection.length != 0) {
                allSections.push(currentSection);
            }
            currentSection = [];
            if (!continuousQuestionIndexing) {
                currentQuestionNumber = 0;
            }
            // section header
            grid[1][nextEmptyLine] = 5;
            nextEmptyLine += 2;
            isFirstOfNewSection = false;
        }

        this.YStart = nextEmptyLine;
        this.onWhichPage = pages.length;

        let questionsAdded = 0;

        let gridPointer = [3, this.YStart];

        // open ended regions
        for (let y = 0; y < this.rows; y++) {
            for (let i = 0; i < this.cols; i++) {
                if (questionsAdded == this.sectionQuestionCount) {
                    break;
                }
                let newQuestion = new Question(this, 0);
                newQuestion.addToGrid(gridPointer[0], gridPointer[1]);
                this.questions.push(newQuestion);
                gridPointer[0] += 9;
                questionsAdded++;

                this.questionRegions.push({
                    page: this.onWhichPage,
                    section: allSections.length,
                    type: this.problem_type,
                    x1: newQuestion.xy[0] + 1,
                    y1: newQuestion.xy[1] + 3,
                    x2: newQuestion.xy[0] + 7,
                    y2: newQuestion.xy[1] + 14,
                });
            }
            gridPointer[1] += 16;
            gridPointer[0] = 3;
        }
        nextEmptyLine += this.rows;
        this.YEnd = nextEmptyLine - 1;
        this.onWhichPage = pages.length;

        allRegions.push(...this.questionRegions);
        currentSection.push(this);
        allSubsections.push(this);
    }
}

//generate black guide lines and stuff on the border
function generateGuideLines() {
    for (let i = 0; i < grid_h; i++) {
        let leftCoord = [0, i];
        let rightCoord = [grid_w - 1, i];

        guideLineCoords[i] = leftCoord;
        guideLineCoords[i + grid_h] = rightCoord;

        fill(leftCoord, 2);
        fill(rightCoord, 2);
    }
}

function fill(coordinates, type) {
    grid[coordinates[0]][coordinates[1]] = type;
}

function generateHeader() {
    // UUID in binary
    let binaryIndex = 0;
    let headerYStart = 3;
    let headerXEnd = grid_w - 3;
    for (let y = 0; y < 4; y++) {
        for (let x = 0; x < 24; x++) {
            if (testIDBinary.slice(binaryIndex, binaryIndex + 1) == 0) {
                fill([headerXEnd - 24 + x, headerYStart + y], 3); // empty circle
            } else {
                fill([headerXEnd - 24 + x, headerYStart + y], 6); // filled circle
            }
            binaryIndex++;
        }
    }

    let pageInBinary = (pages.length + 1).toString(2);
    while (pageInBinary.length < 8) {
        pageInBinary = "0" + pageInBinary;
    }

    let pageInBinaryBackwards;
    for (let y = 0; y < 4; y++) {
        for (let x = 0; x < 2; x++) {
            if (pageInBinary.slice(8 - 2 * y - x - 1, 8 - 2 * y - x) == 0) {
                pageInBinaryBackwards += "0";
            } else {
                pageInBinaryBackwards += "1";
            }
        }
    }

    //page number in binary
    for (let y = 0; y < 4; y++) {
        for (let x = 0; x < 2; x++) {
            if (pageInBinary.slice(8 - 2 * y - x - 1, 8 - 2 * y - x) == 0) {
                fill([headerXEnd - 26 + x, headerYStart + y], 3);
            } else {
                fill([headerXEnd - 26 + x, headerYStart + y], 6);
            }
        }
    }
}

const page_add = function () {
    let gridCopy = [];

    //make a copy of global variable grid
    for (let y = 0; y < grid.length; y++) {
        let temp = [];
        for (let x = 0; x < grid[0].length; x++) {
            temp.push(grid[y][x]);
        }
        gridCopy.push(temp);
    }

    //push the copy into pages array
    pages.push(gridCopy);

    //clear grid, turn all elements to 0
    for (let y = 0; y < grid[0].length; y++) {
        for (let x = 0; x < grid.length; x++) {
            if (grid[x][y] != 2) {
                grid[x][y] = 0;
            }
        }
    }

    generateHeader();
    nextEmptyLine = headerDivider;
};

export const generate = function (test_json, identifier = "_id") {
    test = test_json;
    pages = [];
    grid = new Array(grid_w);
    xOffset = cell_w / 3; //small offset for numbers and stuff
    isFirstOfNewSection = true;

    //making the grid a bit bigger in case of overflow
    let maxXSize = grid_w + 15;
    let maxYSize = grid_h + 15;
    for (let x = 0; x < maxXSize; x++) {
        grid[x] = new Array(maxYSize);
    }

    // set all grid values to 0 for unused
    for (let x = 0; x < maxXSize; x++) {
        for (let y = 0; y < maxYSize; y++) {
            grid[x][y] = 0;
        }
    }

    testIDBinaryRegion = [];
    allRegions = [];
    allSubsections = [];
    allSections = [];
    allQuestions = [];
    currentSection = [];
    guideLineCoords = [];

    headerDivider = 7; // number of yintervals the header space has
    nextEmptyLine = headerDivider; // start first section here

    currentQuestionNumber = 0;
    switch (test.type) {
        case "MCVSD":
        case "MCVSD Focus Group":
        case "HSPT":
        case "Delbarton":
            continuousQuestionIndexing = true;
            break;
    }

    // turns hex into binary
    function hexToBinary(hexInput) {
        hexInput = hexInput.replace("0x", "").toLowerCase();
        var binaryOutput = "";
        for (var c of hexInput) {
            switch (c) {
                case "0":
                    binaryOutput += "0000";
                    break;
                case "1":
                    binaryOutput += "0001";
                    break;
                case "2":
                    binaryOutput += "0010";
                    break;
                case "3":
                    binaryOutput += "0011";
                    break;
                case "4":
                    binaryOutput += "0100";
                    break;
                case "5":
                    binaryOutput += "0101";
                    break;
                case "6":
                    binaryOutput += "0110";
                    break;
                case "7":
                    binaryOutput += "0111";
                    break;
                case "8":
                    binaryOutput += "1000";
                    break;
                case "9":
                    binaryOutput += "1001";
                    break;
                case "a":
                    binaryOutput += "1010";
                    break;
                case "b":
                    binaryOutput += "1011";
                    break;
                case "c":
                    binaryOutput += "1100";
                    break;
                case "d":
                    binaryOutput += "1101";
                    break;
                case "e":
                    binaryOutput += "1110";
                    break;
                case "f":
                    binaryOutput += "1111";
                    break;
                default:
                    return "";
            }
        }
        return binaryOutput;
    }

    testIDBinary = hexToBinary(String(test[identifier]));
    generateGuideLines();
    generateHeader();

    if (test && Array.isArray(test.sections)) {
        test.sections.forEach((section, section_index) => {
            isFirstOfNewSection = true;
            // setup subsection
            let subsection_problems = 0;
            /** @type {EnumProblemResponseType} */
            let subsection_type = "multipleChoice";
            let subsection_choices = 4;
            if (Array.isArray(section.problemIds)) {
                const problems = /** @type {Array<ClientProblem|null>} */ (section.problemIds);
                const firstProblemWithResponseType = problems.find((problem) => problem?.response?.type);
                if (firstProblemWithResponseType && firstProblemWithResponseType.response?.type) {
                    subsection_type = firstProblemWithResponseType.response.type;
                    subsection_choices = (firstProblemWithResponseType?.response?.choices ?? []).length;
                }
            }

            // setup section
            let section_problems = 0;
            if (Array.isArray(section.problemIds)) {
                section_problems = section.problemIds.length;
            }

            let problem_index = 0;
            while (problem_index < section_problems) {
                const problem = /** @type {ClientProblem} */ (section.problemIds[problem_index]);
                if (!problem) {
                    problem_index++;
                    continue;
                }

                let problemTypeChanged = true;
                switch (subsection_type) {
                    case "multipleChoice":
                        if (problem.response.type === "multipleChoice") {
                            if ((problem.response.choices ?? []).length === subsection_choices) {
                                subsection_problems++;
                                problemTypeChanged = false;
                            }
                        }
                        break;
                    case "value":
                        if (problem.response.type === subsection_type) {
                            subsection_problems++;
                            problemTypeChanged = false;
                        }
                        break;
                    case "range":
                        if (problem.response.type === subsection_type) {
                            subsection_problems++;
                            problemTypeChanged = false;
                        }
                        break;
                }

                if (problemTypeChanged || problem_index === section_problems - 1) {
                    switch (subsection_type) {
                        case "multipleChoice": {
                            let choices = 4;
                            if (testAssertions[test.type]) {
                                const testAssertion = testAssertions[test.type];
                                if (Array.isArray(testAssertion.sections) && section_index < testAssertion.sections.length) {
                                    const sectionAssertion = testAssertion.sections[section_index];
                                    if (Array.isArray(sectionAssertion.problemResponseTypes) && sectionAssertion.problemResponseTypes.includes(subsection_type)) {
                                        if (sectionAssertion.problemChoiceCount !== undefined && sectionAssertion.problemChoiceCount > 0) {
                                            choices = sectionAssertion.problemChoiceCount;
                                        }
                                    }
                                }
                            }
                            new SubsectionMultipleChoice(subsection_problems, subsection_type, choices);
                            break;
                        }
                        case "value":
                        case "range":
                            new SubsectionOpenEnded(subsection_problems, problem.response.type);
                            break;
                    }
                    if (problemTypeChanged) {
                        // reset problems for next subsection
                        subsection_type = /** @type {EnumProblemResponseType} */ (problem.response.type);
                        subsection_problems = 1;
                    }
                }
                problem_index++;
            }
        });
    }

    allSections.push(currentSection);
    pages.push(grid);

    return new bubbleSheetRawInfo(identifier);
};

export const render = function () {
    // add svg document to page
    draw = SVG()
        .addTo("body")
        .size(canvas_w, canvas_h * pages.length);
    // draw background across all pages
    draw.rect(canvas_w, canvas_h * pages.length).attr({ fill: "#fff" });

    drawGreyBackgrounds();
    render_text();
    // draw bubbles and row markers
    let section_index = 0;
    let sections_rendered = 0;
    for (let i = 0; i < pages.length; i++) {
        sections_rendered += drawBubblesAndBoxes(i, section_index);
        section_index += sections_rendered;
    }
    drawLinesAroundGridQuestions();
    render_headers();
};

function drawGreyBackgrounds() {
    const color = "#eaeaea";

    for (let s = 0; s < allSubsections.length; s++) {
        let tempSec = allSubsections[s];
        let yOffsetForPage = tempSec.onWhichPage * (canvas_h + margin);
        let tempImage;

        let eyeGuideX = canvas_w - margin * 2 - 4.5 * cell_w;
        let eyeGuideY = cell_h;

        switch (tempSec.problem_type) {
            case "multipleChoice":
                // gray background every three lines
                for (let y = 3; y < tempSec.rows + 1; y += 3) {
                    tempImage = draw.rect(eyeGuideX, eyeGuideY).attr({
                        fill: color,
                        x: margin + 2 * cell_w,
                        y: margin + yOffsetForPage + (tempSec.YStart + y - 1.5) * cell_h,
                    });
                }
                break;
        }
    }
}

function render_text() {
    for (let i = 0; i < allSubsections.length; i++) {
        //English, ,mathematics, reading, science
        let subsection = allSubsections[i];
        //console.log(subsection, "subsection");

        let yOffsetForPage = subsection.onWhichPage * (canvas_h + margin);

        for (let j = 0; j < subsection.questions.length; j++) {
            let question = subsection.questions[j];

            // problem number
            let text_question = draw.text(question.questionIndex);
            text_question
                .attr({
                    "text-anchor": "end",
                    x: question.xy[0] * cell_w + margin + xOffset * 2,
                    y: question.xy[1] * cell_h + margin + yOffsetForPage + cell_h / 5,
                })
                .addClass("problem-number");

            // choices
            let pointer;
            switch (question.type) {
                case 0: // open ended
                    // slash
                    pointer = [question.xy[0] + 2, question.xy[1] + 3];
                    for (let x = 0; x < 2; x++) {
                        let letter = draw.text("/");
                        letter
                            .attr({
                                x: pointer[0] * cell_w + margin,
                                y: pointer[1] * cell_h + margin + yOffsetForPage + cell_h / 5,
                            })
                            .addClass("problem-choice");
                        pointer[0] += 2;
                    }
                    // dot
                    pointer = [question.xy[0], question.xy[1] + 4];
                    for (let x = 0; x < 4; x++) {
                        let letter = draw.text(".");
                        letter
                            .attr({
                                x: pointer[0] * cell_w + margin,
                                y: pointer[1] * cell_h + margin + yOffsetForPage + cell_h / 5,
                            })
                            .addClass("problem-choice");
                        pointer[0] += 2;
                    }
                    // digits
                    pointer = [question.xy[0], question.xy[1] + 6];
                    for (let x = 0; x < 1; x++) {
                        for (let y = 1; y < 10; y++) {
                            let digit = draw.text(y);
                            digit
                                .attr({
                                    x: pointer[0] * cell_w + margin - xOffset / 3,
                                    y: pointer[1] * cell_h + margin + yOffsetForPage + cell_h / 5,
                                })
                                .addClass("problem-choice");
                            pointer[1]++;
                        }
                        pointer[0] += 2;
                        pointer[1] = question.xy[1] + 5;
                    }
                    for (let x = 1; x < 4; x++) {
                        for (let y = 0; y < 10; y++) {
                            let digit = draw.text(y);
                            digit
                                .attr({
                                    x: pointer[0] * cell_w + margin - xOffset / 3,
                                    y: pointer[1] * cell_h + margin + yOffsetForPage + cell_h / 5,
                                })
                                .addClass("problem-choice");
                            pointer[1]++;
                        }
                        pointer[0] += 2;
                        pointer[1] = question.xy[1] + 5;
                    }

                    break;
                case 1: // multiple choice
                    pointer = [question.xy[0] + 1, question.xy[1]];

                    for (let l = 0; l < subsection.choices; l++) {
                        //answer to be displayed, 0 = A, 1 = B, 2 = C etc.
                        const answerKey = l;

                        const problemOptions = {
                            testType: test.type,
                            problemType: subsection.problem_type,
                            problemIndex: question.questionIndex - 1,
                        };
                        const char = solutionMultipleChoiceToString(answerKey, problemOptions);

                        draw.text(char)
                            .attr({
                                "text-anchor": "end",
                                x: pointer[0] * cell_w + cell_w * 0.4 + margin,
                                y: pointer[1] * cell_h + cell_h * 0.2 + margin + yOffsetForPage,
                            })
                            .addClass("problem-choice");
                        pointer[0] += 2;
                    }
                    break;
            }
        }
    }
}

function drawBubblesAndBoxes(page, section_index) {
    let yOffsetForPage = page * (canvas_h + margin);

    const row_marker_w = (cell_h / 2) * 2.25;
    const row_marker_h = cell_h / 2;
    const bubble_size = Math.min(cell_h, cell_w) * 0.8;
    // top left orientation marker
    draw.rect(row_marker_w * 1.5, row_marker_h * 3).attr({
        fill: "#000",
        x: margin - ((cell_h / 2) * 2.25 - (0 + 1) * cell_w),
        y: 0 * cell_h + margin - cell_h / 2 / 2 + yOffsetForPage,
    });
    // top right orientation marker
    draw.rect(row_marker_w * 1.5, row_marker_h * 3).attr({
        fill: "#000",
        x: margin - ((cell_h / 2) * 2.25 - (grid_w - 0.75) * cell_w),
        y: 0 * cell_h + margin - cell_h / 2 / 2 + yOffsetForPage,
    });

    // Bottom orientation markers — same columns as the top pair, mirrored into the
    // bottom-margin band. The canvas is a FIXED 850×1100 page, so these add no
    // height (no overflow / page-split); they simply occupy the bottom margin the
    // way the top pair occupies the top margin. These four large solid squares are
    // the detector's deskew corners (MARKER_UV), which is why the per-row markers
    // below can all be hollow.
    const bottom_marker_y = canvas_h - margin + cell_h / 2 / 2 - row_marker_h * 3 + yOffsetForPage;
    // bottom left orientation marker
    draw.rect(row_marker_w * 1.5, row_marker_h * 3).attr({
        fill: "#000",
        x: margin - ((cell_h / 2) * 2.25 - (0 + 1) * cell_w),
        y: bottom_marker_y,
    });
    // bottom right orientation marker (solid square) ...
    const br_marker_x = margin - ((cell_h / 2) * 2.25 - (grid_w - 0.75) * cell_w);
    draw.rect(row_marker_w * 1.5, row_marker_h * 3).attr({
        fill: "#000",
        x: br_marker_x,
        y: bottom_marker_y,
    });
    // ... with a white notch bitten from its INNER (top-left) corner. Small enough
    // that BR still reads as a solid dark corner for detection, large enough to
    // sample after deskew so the detector can tell BR from the other three corners
    // (and thus detect / auto-correct a 180°-rotated sheet).
    draw.rect(row_marker_w * 1.5 * BR_NOTCH_FRAC, row_marker_h * 3 * BR_NOTCH_FRAC).attr({
        fill: "#fff",
        x: br_marker_x,
        y: bottom_marker_y,
    });

    let sections_rendered = 0;
    for (let yC = 0; yC < grid_h; yC++) {
        for (let xC = 0; xC < grid_w; xC++) {
            let numberInGrid = pages[page][xC][yC];
            if (numberInGrid < 2 || numberInGrid == 4) {
                continue;
            }

            switch (numberInGrid) {
                case 2: // row markers — all hollow now. The four large corner
                    // orientation markers (above) are the detector's deskew anchors,
                    // so row markers no longer double as corner targets. Skip the
                    // last row too (mirroring the top's yC>1) so they never overlap
                    // the big bottom corner markers.
                    if (yC > 1 && yC < grid_h - 1) {
                        const marker = draw.rect(row_marker_w, row_marker_h).attr({
                            x: (xC + 1) * cell_w + margin - row_marker_w,
                            y: (yC + 0) * cell_h + margin - row_marker_h / 2 + yOffsetForPage,
                        });
                        marker.addClass("marker-empty");
                    }
                    break;
                case 3: // bubble
                    let xCoord = xC * cell_w + margin;
                    let yCoord = yC * cell_h + margin + yOffsetForPage;
                    // stagger bubbles vertically in header
                    if (yC < headerDivider && xC % 2 == 1) {
                        yCoord -= cell_h / 2;
                    }

                    draw.circle(bubble_size)
                        .attr({
                            cx: xCoord,
                            cy: yCoord,
                        })
                        .addClass("bubble-empty");
                    break;
                case 5: // section header
                    let lx1 = xC * cell_w + margin + xOffset;
                    let lx2 = lx1 + canvas_w - margin - cell_w * 5.5;
                    let ly = (yC + 0.5) * cell_h + margin + yOffsetForPage;

                    // section header divider
                    draw.line(lx1, ly + cell_h / 2, lx2, ly + cell_h / 2).attr({
                        stroke: "#000",
                    });
                    // section title background
                    const section_title_rect = draw.rect(cell_w * 4, cell_h);
                    section_title_rect.attr({
                        fill: "#fff",
                        x: lx1,
                        y: ly,
                    });

                    // section title text
                    let section_name = "Section " + (section_index + sections_rendered + 1);
                    if (Array.isArray(test.sections) && section_index + sections_rendered < test.sections.length) {
                        if (test.sections[section_index + sections_rendered].name) {
                            section_name = test.sections[section_index + sections_rendered].name;
                        }
                    }
                    sections_rendered++;

                    const section_title = draw.text(section_name);
                    section_title
                        .attr({
                            x: (xC + 1.0) * cell_w + margin,
                            y: (yC + 1.25) * cell_h + margin + yOffsetForPage,
                        })
                        .addClass("section-title");

                    // resize section title background to text width
                    section_title_rect.width(section_title.bbox().width + cell_w);
                    break;
                case 6: // bubble filled
                    let filledXCoord = xC * cell_w + margin;
                    let filledYCoord = yC * cell_h + margin + yOffsetForPage;
                    // stagger bubbles vertically in header
                    if (yC < headerDivider && xC % 2 == 1) {
                        filledYCoord -= cell_h / 2;
                    }

                    draw.circle(bubble_size)
                        .attr({
                            cx: filledXCoord,
                            cy: filledYCoord,
                        })
                        .addClass("bubble-filled");
                    break;
            }
        }
    }

    return sections_rendered;
}

function drawLinesAroundGridQuestions() {
    function getOffsetPageX(x) {
        return x * cell_w + margin - xOffset;
    }
    function tempFunc(y, section) {
        let yOffsetForPage = section.onWhichPage * (canvas_h + margin);
        return y * cell_h + cell_h / 2.5 + margin + yOffsetForPage;
    }

    for (let section_index = 0; section_index < allSubsections.length; section_index++) {
        let tempSec = allSubsections[section_index];

        for (let q = 0; q < tempSec.questions.length; q++) {
            let curQuestion = tempSec.questions[q];

            if (curQuestion.type == 0) {
                // grid in
                for (let i = 0; i < 5; i++) {
                    draw.line(0, 0, 0, cell_h * 14.65 - cell_h / 2.5)
                        .move(getOffsetPageX(curQuestion.xy[0] + i * 2), tempFunc(curQuestion.xy[1], tempSec))
                        .addClass("border-line");
                }

                draw.line(0, 0, cell_w * 8, 0)
                    .move(getOffsetPageX(curQuestion.xy[0]), tempFunc(curQuestion.xy[1], tempSec))
                    .addClass("border-line");

                draw.line(0, 0, cell_w * 8, 0)
                    .move(getOffsetPageX(curQuestion.xy[0]), tempFunc(curQuestion.xy[1] + 2, tempSec))
                    .addClass("border-line");

                draw.line(0, 0, cell_w * 8, 0)
                    .move(getOffsetPageX(curQuestion.xy[0]), tempFunc(curQuestion.xy[1] + 14.25, tempSec))
                    .addClass("border-line");
            }
        }
    }
}

function render_headers() {
    let lx, ly;
    for (let page = 0; page < pages.length; page++) {
        const yOffsetForPage = page * (canvas_h + margin);

        // first name
        draw.text("First Name")
            .attr({
                "text-anchor": "start",
                x: margin + 2.75 * cell_w,
                y: yOffsetForPage + margin + 1.5 * cell_h,
            })
            .addClass("test-header");

        draw.rect(24 * cell_w, 2 * cell_h)
            .move(margin + 2.75 * cell_w, yOffsetForPage + margin + 1.75 * cell_h)
            .addClass("border-area")
            .addClass("dotted");
        for (var i = 1; i < 12; i++) {
            lx = margin + (2.75 + i * 2) * cell_w;
            ly = yOffsetForPage + margin + 1.75 * cell_h;
            draw.line(lx, ly, lx, ly + 2 * cell_h)
                .addClass("border-area")
                .addClass("dotted");
        }

        // last name
        draw.text("Last Name")
            .attr({
                "text-anchor": "start",
                x: margin + 2.75 * cell_w,
                y: yOffsetForPage + margin + 4.5 * cell_h,
            })
            .addClass("test-header");

        draw.rect(24 * cell_w, 2 * cell_h)
            .move(margin + 2.75 * cell_w, yOffsetForPage + margin + 4.75 * cell_h)
            .addClass("border-area")
            .addClass("dotted");
        for (var i = 1; i < 12; i++) {
            lx = margin + (2.75 + i * 2) * cell_w;
            ly = yOffsetForPage + margin + 4.75 * cell_h;
            draw.line(lx, ly, lx, ly + 2 * cell_h)
                .addClass("border-area")
                .addClass("dotted");
        }

        // test and page number
        draw.text(test.name)
            .attr({
                "text-anchor": "start",
                x: margin + (grid_w - 29.75) * cell_w,
                y: yOffsetForPage + margin + 1.5 * cell_h,
            })
            .addClass("test-header");

        draw.text("Page " + (page + 1))
            .attr({
                "text-anchor": "end",
                x: margin + (grid_w - 3.25) * cell_w,
                y: yOffsetForPage + margin + 1.5 * cell_h,
            })
            .addClass("test-header");

        draw.rect(26.5 * cell_w, 5 * cell_h)
            .move(margin + (grid_w - 29.75) * cell_w, yOffsetForPage + margin + 1.75 * cell_h)
            .addClass("border-area");
    }
}

function debugStuff() {
    // show coordinate grid and regions
    for (let pageNum = 0; pageNum < pages.length; pageNum++) {
        let yStart = pageNum * (canvas_h + margin);

        for (let yC = 0; yC <= grid_h / 10; yC++) {
            let newLine;
            newLine = draw.line(0, 0, canvas_w, 0).move(margin, margin + yC * cell_h * 10 + yStart);
            newLine.stroke({ color: "#00FF00", width: 1, linecap: "round" });
        }
        for (let xC = 0; xC <= grid_w / 10; xC++) {
            //lines per 10grid spots
            let newLine;
            newLine = draw.line(0, 0, 0, canvas_h * pages.length).move(margin + xC * 10 * cell_w, margin);
            newLine.stroke({ color: "#00FF00", width: 1, linecap: "round" });
        }
    }

    for (let pageNum = 0; pageNum < pages.length; pageNum++) {
        let yStart = pageNum * (canvas_h + margin);

        for (let xC = 0; xC < grid_w; xC++) {
            //grid red dots
            for (let yC = 0; yC < grid_h; yC++) {
                let tempImage;
                tempImage = draw.circle(2).attr({ fill: "#FF0000" });
                tempImage.attr({
                    cx: xC * cell_w + margin,
                    cy: yC * cell_h + margin + yStart,
                });
            }
        }
    }

    for (let i = 0; i < allSubsections.length; i++) {
        const subsection = allSubsections[i];
        let yOffsetForPage = subsection.onWhichPage * (canvas_h + margin);
        for (let k = 0; k < subsection.questionRegions.length; k++) {
            let tempRegion = subsection.questionRegions[k];
            let tempImage;

            tempImage = draw.circle(7).attr({ fill: "#FF0000" });
            tempImage.attr({
                cx: tempRegion[0][0] * cell_w + margin,
                cy: tempRegion[0][1] * cell_h + margin + yOffsetForPage,
            });

            let tempImage2;
            tempImage2 = draw.circle(7).attr({ fill: "#FF0000" });
            tempImage2.attr({
                cx: tempRegion[1][0] * cell_w + margin,
                cy: tempRegion[1][1] * cell_h + margin + yOffsetForPage,
            });
        }
    }
}
