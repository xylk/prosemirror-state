const {Transform} = require("prosemirror-transform")
const {Mark} = require("prosemirror-model")
const {Selection} = require("./selection")

const UPDATED_SEL = 1, UPDATED_MARKS = 2, UPDATED_SCROLL = 4

// ::- An editor state transaction, which can be applied to a state to
// create an updated state. Use
// [`EditorState.tr`](#state.EditorState.tr) to create an instance.
//
// Transactions track changes to the document (they are a subclass of
// [`Transform`](#transform.Transform)), but also other state changes,
// like selection updates and adjustments of the set of [stored
// marks](##state.EditorState.storedMarks). In addition, you can store
// metadata properties in a transaction, which are extra pieces of
// information that client code or plugins can use to describe what a
// transacion represents, so that they can update their [own
// state](##state.StateField) accordingly.
//
// The [editor view](##view.EditorView) uses a single metadata
// property: it will attach a property `"pointer"` with the value
// `true` to selection transactions directly caused by mouse or touch
// input.
class Transaction extends Transform {
  constructor(state) {
    super(state.doc)
    // :: number
    // The timestamp associated with this transaction.
    this.time = Date.now()
    this.curSelection = state.selection
    // The step count for which the current selection is valid.
    this.curSelectionFor = 0
    // :: ?[Mark]
    // The stored marks in this transaction.
    this.storedMarks = state.storedMarks
    // Bitfield to track which aspects of the state were updated by
    // this transaction.
    this.updated = 0
    // Object used to store metadata properties for the transaction.
    this.meta = Object.create(null)
  }

  // :: Selection
  // The transform's current selection. This defaults to the
  // editor selection [mapped](#state.Selection.map) through the steps in
  // this transform, but can be overwritten with
  // [`setSelection`](#state.Transaction.setSelection).
  get selection() {
    if (this.curSelectionFor < this.steps.length) {
      this.curSelection = this.curSelection.map(this.doc, this.mapping.slice(this.curSelectionFor))
      this.curSelectionFor = this.steps.length
    }
    return this.curSelection
  }

  // :: (Selection) → Transaction
  // Update the transaction's current selection. This will determine
  // the selection that the editor gets when the transaction is
  // applied.
  setSelection(selection) {
    this.curSelection = selection
    this.curSelectionFor = this.steps.length
    this.updated = (this.updated | UPDATED_SEL) & ~UPDATED_MARKS
    this.storedMarks = null
    return this
  }

  // :: bool
  // Whether the selection was explicitly updated by this transaction.
  get selectionSet() {
    return (this.updated & UPDATED_SEL) > 0
  }

  // :: (?[Mark]) → Transaction
  // Replace the set of stored marks.
  setStoredMarks(marks) {
    this.storedMarks = marks
    this.updated |= UPDATED_MARKS
    return this
  }

  // :: bool
  // Whether the stored marks were explicitly set for this transaction.
  get storedMarksSet() {
    return (this.updated & UPDATED_MARKS) > 0
  }

  addStep(step, doc) {
    super.addStep(step, doc)
    this.updated = this.updated & ~UPDATED_MARKS
    this.storedMarks = null
  }

  // :: (number) → Transaction
  // Update the timestamp for the transaction.
  setTime(time) {
    this.time = time
    return this
  }

  // :: (Slice) → Transaction
  replaceSelection(slice) {
    let {from, to} = this.selection, startLen = this.steps.length
    this.replaceRange(from, to, slice)
    // Move the selection to the position after the inserted content.
    // When that ended in an inline node, search backwards, to get the
    // position after that node. If not, search forward.
    let lastNode = slice.content.lastChild, lastParent = null
    for (let i = 0; i < slice.openRight; i++) {
      lastParent = lastNode
      lastNode = lastNode.lastChild
    }
    selectionToInsertionEnd(this, startLen, (lastNode ? lastNode.isInline : lastParent && lastParent.isTextblock) ? -1 : 1)
    return this
  }

  // :: (Node, ?bool) → Transaction
  // Replace the selection with the given node or slice, or delete it
  // if `content` is null. When `inheritMarks` is true and the content
  // is inline, it inherits the marks from the place where it is
  // inserted.
  replaceSelectionWith(node, inheritMarks) {
    let {$from, from, to} = this.selection, startLen = this.steps.length
    if (inheritMarks !== false)
      node = node.mark(this.storedMarks || $from.marks(to > from))
    this.replaceRangeWith(from, to, node)
    selectionToInsertionEnd(this, startLen, node.isInline ? -1 : 1)
    return this
  }

  // :: () → Transaction
  // Delete the selection.
  deleteSelection() {
    let {from, to} = this.selection
    return this.deleteRange(from, to)
  }

  // :: (string, from: ?number, to: ?number) → Transaction
  // Replace the given range, or the selection if no range is given,
  // with a text node containing the given string.
  insertText(text, from, to = from) {
    let schema = this.doc.type.schema
    if (from == null) {
      if (!text) return this.deleteSelection()
      return this.replaceSelectionWith(schema.text(text), true)
    } else {
      if (!text) return this.deleteRange(from, to)
      let node = schema.text(text, this.storedMarks || this.doc.resolve(from).marks(to > from))
      return this.replaceRangeWith(from, to, node)
    }
  }

  // :: (union<string, Plugin, PluginKey>, any) → Transaction
  // Store a metadata property in this transaction, keyed either by
  // name or by plugin.
  setMeta(key, value) {
    this.meta[typeof key == "string" ? key : key.key] = value
    return this
  }

  // :: (union<string, Plugin, PluginKey>) → any
  // Retrieve a metadata property for a given name or plugin.
  getMeta(key) {
    return this.meta[typeof key == "string" ? key : key.key]
  }

  // :: bool
  // Returns true if this transaction doesn't contain any metadata,
  // and can thus be safely extended.
  get isGeneric() {
    for (let _ in this.meta) return false
    return true
  }

  // :: () → Transaction
  // Indicate that the editor should scroll the selection into view
  // when updated to the state produced by this transaction.
  scrollIntoView() {
    this.updated |= UPDATED_SCROLL
    return this
  }

  get scrolledIntoView() {
    return (this.updated & UPDATED_SCROLL) > 0
  }

  // :: (Mark) → Transaction
  // Add a mark to the set of stored marks.
  addStoredMark(mark) {
    this.storedMarks = mark.addToSet(this.storedMarks || currentMarks(this.selection))
    return this
  }

  // :: (union<Mark, MarkType>) → Transaction
  // Remove a mark or mark type from the set of stored marks.
  removeStoredMark(mark) {
    this.storedMarks = mark.removeFromSet(this.storedMarks || currentMarks(this.selection))
    return this
  }
}
exports.Transaction = Transaction

function selectionToInsertionEnd(tr, startLen, bias) {
  if (tr.steps.length == startLen) return
  let map = tr.mapping.maps[tr.mapping.maps.length - 1], end
  map.forEach((_from, _to, _newFrom, newTo) => end = newTo)
  if (end != null) tr.setSelection(Selection.near(tr.doc.resolve(end), bias))
}

function currentMarks(selection) {
  return selection.head == null ? Mark.none : selection.$head.marks()
}
