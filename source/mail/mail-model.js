// -------------------------------------------------------------------------- \\
// File: mail-model.js                                                        \\
// Module: MailModel                                                          \\
// Requires: API, Mailbox.js, Thread.js, Message.js, MessageList.js           \\
// Author: Neil Jenkins                                                       \\
// License: © 2010-2015 FastMail Pty Ltd. MIT Licensed.                       \\
// -------------------------------------------------------------------------- \\

/*global O, JMAP */

"use strict";

( function ( JMAP ) {

var store = JMAP.store;
var Mailbox = JMAP.Mailbox;
var Thread = JMAP.Thread;
var Message = JMAP.Message;
var MessageList = JMAP.MessageList;

// --- Preemptive mailbox count updates ---

var getMailboxDelta = function ( deltas, mailboxId ) {
    return deltas[ mailboxId ] || ( deltas[ mailboxId ] = {
        totalMessages: 0,
        unreadMessages: 0,
        totalThreads: 0,
        unreadThreads: 0,
        removed: [],
        added: []
    });
};

var updateMailboxCounts = function ( mailboxDeltas ) {
    var mailboxId, delta, mailbox;
    for ( mailboxId in mailboxDeltas ) {
        delta = mailboxDeltas[ mailboxId ];
        mailbox = store.getRecord( Mailbox, mailboxId );
        if ( delta.totalMessages ) {
            mailbox.increment( 'totalMessages', delta.total );
        }
        if ( delta.unreadMessages ) {
            mailbox.increment( 'unreadMessages', delta.unread );
        }
        if ( delta.totalThreads ) {
            mailbox.increment( 'totalThreads', delta.totalThreads );
        }
        if ( delta.unreadThreads ) {
            mailbox.increment( 'unreadThreads', delta.unreadThreads );
        }
        // Fetch the real counts, just in case. We set it obsolete
        // first, so if another fetch is already in progress, the
        // results of that are discarded and it is fetched again.
        mailbox.setObsolete()
               .refresh();
    }
};

// --- Preemptive query updates ---

var isSortedOnUnread = function ( sort ) {
    for ( var i = 0, l = sort.length; i < l; i += 1 ) {
        if ( /isUnread/.test( sort[i] ) ) {
            return true;
        }
    }
    return false;
};
var isFilteredOnUnread = function ( filter ) {
    if ( filter.operator ) {
        return filter.conditions.some( isFilteredOnUnread );
    }
    return 'isUnread' in filter;
};
var isSortedOnFlagged = function ( sort ) {
    for ( var i = 0, l = sort.length; i < l; i += 1 ) {
        if ( /isFlagged/.test( sort[i] ) ) {
            return true;
        }
    }
    return false;
};
var isFilteredOnFlagged = function ( filter ) {
    if ( filter.operator ) {
        return filter.conditions.some( isFilteredOnFlagged );
    }
    return 'isFlagged' in filter;
};
var isFilteredOnMailboxes = function ( filter ) {
    if ( filter.operator ) {
        return filter.conditions.some( isFilteredOnMailboxes );
    }
    return 'inMailboxes' in filter;
};
var isFilteredJustOnMailbox = function ( filter ) {
    var isJustMailboxes = false,
        term;
    for ( term in filter ) {
        if ( term === 'inMailboxes' && filter[ term ].length === 1 ) {
            isJustMailboxes = true;
        } else {
            isJustMailboxes = false;
            break;
        }
    }
    return isJustMailboxes;
};
var isTrue = function () {
    return true;
};
var isFalse = function () {
    return false;
};

// ---

var reOrFwd = /^(?:(?:re|fwd):\s*)+/;
var comparators = {
    id: function ( a, b ) {
        var aId = a.get( 'id' );
        var bId = b.get( 'id' );

        return aId < bId ? -1 : aId > bId ? 1 : 0;
    },
    date: function ( a, b ) {
        return a.get( 'date' ) - b.get( 'date' );
    },
    size: function ( a, b ) {
        return a.get( 'size' ) - b.get( 'size' );
    },
    from: function ( a, b ) {
        var aFrom = a.get( 'from' );
        var bFrom = b.get( 'from' );
        var aFromPart = aFrom ? aFrom.name || aFrom.email : '';
        var bFromPart = bFrom ? bFrom.name || bFrom.email : '';

        return aFromPart < bFromPart ? -1 : aFromPart > bFromPart ? 1 : 0;
    },
    to: function ( a, b ) {
        var aTo = a.get( 'to' );
        var bTo = b.get( 'to' );
        var aToPart = aTo && aTo.length ? aTo[0].name || aTo[0].email : '';
        var bToPart = bTo && bTo.length ? bTo[0].name || bTo[0].email : '';

        return aToPart < bToPart ? -1 : aTo > bToPart ? 1 : 0;
    },
    subject: function ( a, b ) {
        var aSubject = a.get( 'subject' ).replace( reOrFwd, '' );
        var bSubject = b.get( 'subject' ).replace( reOrFwd, '' );

        return aSubject < bSubject ? -1 : aSubject > bSubject ? 1 : 0;
    },
    isFlagged: function ( a, b ) {
        var aFlagged = a.get( 'isFlagged' );
        var bFlagged = b.get( 'isFlagged' );

        return aFlagged === bFlagged ? 0 :
            aFlagged ? -1 : 1;
    },
    isFlaggedThread: function ( a, b ) {
        return comparators.isFlagged( a.get( 'thread' ), b.get( 'thread' ) );
    }
};

var compareToId = function ( fields, id, message ) {
    var otherMessage = id && ( store.getRecordStatus( Message, id ) & READY ) ?
            store.getRecord( Message, id ) : null;
    var i, l, comparator, result;
    if ( !otherMessage ) {
        return 1;
    }
    for ( i = 0, l = fields.length; i < l; i += 1 ) {
        comparator = comparators[ fields[i][0] ];
        if ( comparator && ( result = comparator( otherMessage, message ) ) ) {
            return result * fields[i][1];
        }
    }
    return 0;
};

var compareToMessage = function ( fields, aData, bData ) {
    var a = aData.message;
    var b = bData.message;
    var i, l, comparator, result;
    for ( i = 0, l = fields.length; i < l; i += 1 ) {
        comparator = comparators[ fields[i] ];
        if ( comparator && ( result = comparator( a, b ) ) ) {
            return result;
        }
    }
    return 0;
};

var splitDirection = function ( fields, collapseThreads ) {
    return fields.map( function ( field ) {
        var space = field.indexOf( ' ' ),
            prop = space ? field.slice( 0, space ) : field,
            dir = space && field.slice( space + 1 ) === 'asc' ? 1 : -1;

        if ( collapseThreads && /^is/.test( prop ) ) {
            prop += 'Thread';
        }
        return [ prop, dir ];
    });
};

var calculatePreemptiveAdd = function ( query, addedMessages ) {
    var idList = query._list;
    var sort = splitDirection(
        query.get( 'sort' ), query.get( 'collapseThreads' ) );
    var comparator = compareToId.bind( null, sort );
    var added = addedMessages.reduce( function ( added, message ) {
            var messageId = message.get( 'id' );
            if ( messageId ) {
                added.push({
                    message: message,
                    messageId: messageId,
                    threadId: message.get( 'threadId' ),
                    // Can't insert draft messages for now; would need to use
                    // store keys in the remote quries instead of message ids.
                    index: messageId ?
                        idList.binarySearch( message, comparator ) : -1
                });
            }
            return added;
        }, [] );

    var collapseThreads = query.get( 'collapseThreads' );
    var messageToThreadId = query.get( 'messageToThreadId' );
    var threadToMessageId = collapseThreads && added.length ?
            idList.reduce( function ( map, messageId ) {
                if ( messageId ) {
                    map[ messageToThreadId[ messageId ] ] = messageId;
                }
                return map;
            }, {} ) :
            {};

    added.sort( compareToMessage.bind( null, sort ) );

    return added.length ? added.reduce( function ( result, item ) {
        var messageId = item.messageId;
        var threadId = item.threadId;
        if ( !collapseThreads || !threadToMessageId[ threadId ] ) {
            threadToMessageId[ threadId ] = messageId;
            messageToThreadId[ messageId ] = threadId;
            result.push([ item.index + result.length, messageId ]);
        }
        return result;
    }, [] ) : null;
};

var updateQueries = function ( filterTest, sortTest, deltas ) {
    // Set as obsolete any message list that is filtered by
    // one of the removed or added mailboxes. If it's a simple query,
    // pre-emptively update it.
    var queries = store.getAllRemoteQueries();
    var l = queries.length;
    var query, filter, sort, delta;
    while ( l-- ) {
        query = queries[l];
        if ( query instanceof MessageList ) {
            filter = query.get( 'filter' );
            sort = query.get( 'sort' );
            if ( deltas && isFilteredJustOnMailbox( filter ) ) {
                delta = deltas[ filter.inMailboxes[0] ];
                if ( delta ) {
                    query.clientDidGenerateUpdate({
                        added: calculatePreemptiveAdd( query, delta.added ),
                        removed: delta.removed
                    });
                }
            } else if ( filterTest( filter ) || sortTest( sort ) ) {
                query.setObsolete();
            }
        }
    }
};

// ---

var identity = function ( v ) { return v; };

var addMoveInverse = function ( inverse, undoManager, willAdd, willRemove, messageId ) {
    var l = willRemove ? willRemove.length : 1;
    var i, addMailboxId, removeMailboxId, data;
    for ( i = 0; i < l; i += 1 ) {
        addMailboxId = willAdd ? willAdd[0].get( 'id' ) : '-';
        removeMailboxId = willRemove ? willRemove[i].get( 'id' ) : '-';
        data = inverse[ addMailboxId + removeMailboxId ];
        if ( !data ) {
            data = {
                method: 'move',
                messageIds: [],
                args: [
                    null,
                    willRemove && removeMailboxId,
                    willAdd && addMailboxId,
                    true
                ]
            };
            inverse[ addMailboxId + removeMailboxId ] = data;
            undoManager.pushUndoData( data );
        }
        data.messageIds.push( messageId );
        willAdd = null;
    }
};

// ---

var READY = O.Status.READY;

var NO = 0;
var TO_THREAD = 1;
var TO_MAILBOX = 2;

var getMessages = function getMessages ( ids, expand, mailbox, messageToThreadId, callback, hasDoneLoad ) {
    // Map to threads, then make sure all threads, including headers
    // are loaded
    var allLoaded = true,
        messages = [],
        inTrash;

    var checkMessage = function ( message ) {
        if ( message.is( READY ) ) {
            if ( expand === TO_MAILBOX && mailbox ) {
                if ( message.get( 'mailboxes' ).contains( mailbox ) ) {
                    messages.push( message );
                }
            } else if ( expand === TO_THREAD ) {
                if ( message.isIn( 'trash' ) === inTrash ) {
                    messages.push( message );
                }
            } else {
                messages.push( message );
            }
        } else {
            allLoaded = false;
        }
    };

    ids.forEach( function ( id ) {
        var message = store.getRecord( Message, id ),
            threadId = messageToThreadId[ id ],
            thread;
        inTrash = message.isIn( 'trash' );
        if ( expand && threadId ) {
            thread = store.getRecord( Thread, threadId );
            if ( thread.is( READY ) ) {
                thread.get( 'messages' ).forEach( checkMessage );
            } else {
                allLoaded = false;
            }
        } else {
            checkMessage( message );
        }
    });

    if ( allLoaded || hasDoneLoad ) {
        JMAP.mail.gc.isPaused = false;
        callback( messages );
    } else {
        // Suspend gc and wait for next API request: guaranteed to load
        // everything
        JMAP.mail.gc.isPaused = true;
        JMAP.mail.addCallback(
            getMessages.bind( null,
                ids, expand, mailbox, messageToThreadId, callback, true )
        );
    }
    return true;
};

// ---

var doUndoAction = function ( method, args ) {
    return function ( callback, messages ) {
        var mail = JMAP.mail;
        if ( messages ) {
            args[0] = messages;
        }
        mail[ method ].apply( mail, args );
        callback( null );
    };
};

// ---

var byFolderTreeOrder = function ( a, b ) {
    if ( a === b ) {
        return 0;
    }
    if ( a.get( 'parent' ) !== b.get( 'parent' ) ) {
        var aParents = [a],
            bParents = [b],
            parent = a,
            al, bl;

        while ( parent = parent.get( 'parent' ) ) {
            if ( parent === b ) {
                return 1;
            }
            aParents.push( parent );
        }
        parent = b;
        while ( parent = parent.get( 'parent' ) ) {
            if ( parent === a ) {
                return -1;
            }
            bParents.push( parent );
        }

        al = aParents.length;
        bl = bParents.length;
        while ( al-- && bl-- ) {
            if ( ( a = aParents[ al ] ) !== ( b = bParents[ bl ] ) ) {
                break;
            }
        }
    }
    return ( a.get( 'sortOrder' ) - b.get( 'sortOrder' ) ) ||
        O.i18n.compare( a.get( 'displayName' ), b.get( 'displayName' ) ) ||
        ( a.get( 'id' ) < b.get( 'id' ) ? -1 : 1 );
};

var rootMailboxes = store.getQuery( 'rootMailboxes', O.LiveQuery, {
    Type: Mailbox,
    filter: function ( data ) {
        return !data.parentId;
    },
    sort: [ 'sortOrder', 'name' ]
});

var allMailboxes = new O.ObservableArray( null, {
    content: store.getQuery( 'allMailboxes', O.LiveQuery, {
        Type: Mailbox
    }),
    contentDidChange: function () {
        var mailboxes = this.get( 'content' ).get( '[]' );
        mailboxes.sort( byFolderTreeOrder );
        return this.set( '[]', mailboxes );
    }
}).contentDidChange();
store.on( Mailbox, allMailboxes, 'contentDidChange' );

var systemMailboxIds = new O.Object({
    foldersDidChange: function () {
        rootMailboxes.forEach( function ( mailbox ) {
            var role = mailbox.get( 'role' );
            if ( role ) {
                this.set( role, mailbox.get( 'id' ) );
            }
            if ( mailbox.get( 'name' ) === 'Templates' ) {
                this.set( 'templates', mailbox.get( 'id' ) );
            }
        }, this );
    }
});
rootMailboxes.addObserverForKey( '[]', systemMailboxIds, 'foldersDidChange' );

// ---

O.extend( JMAP.mail, {

    getMessages: getMessages,

    gc: new O.MemoryManager( store, [
        {
            Type: Message,
            max: 1200
        },
        {
            Type: Thread,
            max: 1000
        },
        {
            Type: MessageList,
            max: 5,
            // This is really needed to check for disappearing Messages/Threads,
            // but more efficient to run it here.
            afterCleanup: function () {
                var queries = store.getAllRemoteQueries(),
                    l = queries.length,
                    query;
                while ( l-- ) {
                    query = queries[l];
                    if ( query instanceof MessageList ) {
                        query.recalculateFetchedWindows();
                    }
                }
            }
        }
    ], 60000 ),

    undoManager: new O.UndoManager({

        store: store,

        maxUndoCount: 10,

        pending: [],
        sequence: null,

        getUndoData: function () {
            var data = this.pending;
            if ( data.length ) {
                this.pending = [];
            } else {
                data = null;
            }
            return data;
        },

        pushUndoData: function ( data ) {
            this.pending.push( data );
            if ( !this.get( 'sequence' ) ) {
                this.dataDidChange();
            }
            return data;
        },

        applyChange: function ( data ) {
            var mail = JMAP.mail;
            var pending = this.pending;
            var sequence = new JMAP.Sequence();
            var l = data.length;
            var call, ids;

            while ( l-- ) {
                call = data[l];
                ids = call.messageIds;
                if ( ids ) {
                    sequence.then(
                        mail.getMessages.bind( null, ids, NO, null, {} ) );
                }
                sequence.then( doUndoAction( call.method, call.args ) );
            }

            sequence.afterwards = function () {
                this.set( 'sequence', null );
                if ( !pending.length ) {
                    var redoStack = this._redoStack;
                    if ( redoStack.last() === pending ) {
                        redoStack.pop();
                        this.set( 'canRedo', !!redoStack.length );
                    }
                }
                this.pending = [];
            }.bind( this );

            this.set( 'sequence', sequence );

            sequence.go( null );

            return pending;
        }
    }),

    // ---

    byFolderTreeOrder: byFolderTreeOrder,

    rootMailboxes: rootMailboxes,

    allMailboxes: allMailboxes,

    systemMailboxIds: systemMailboxIds,

    // ---

    setUnread: function ( messages, isUnread, allowUndo ) {
        var mailboxDeltas = {};
        var trashId = systemMailboxIds.get( 'trash' );
        var inverseMessageIds = allowUndo ? [] : null;
        var inverse = allowUndo ? {
                method: 'setUnread',
                messageIds: inverseMessageIds,
                args: [
                    null,
                    !isUnread,
                    true
                ]
            } : null;

        messages.forEach( function ( message ) {
            // Check we have something to do
            if ( message.get( 'isUnread' ) === isUnread ) {
                return;
            }

            // Get the thread and cache the current unread state
            var thread = message.get( 'thread' );
            var isInTrash = message.get( 'isInTrash' );
            var threadUnread =
                    thread &&
                    ( isInTrash ?
                        thread.get( 'isUnreadInTrash' ) :
                        thread.get( 'isUnread' ) ) ?
                    1 : 0;
            var mailboxCounts, mailboxId, mailbox, delta;

            // Update the message
            message.set( 'isUnread', isUnread );

            // Add inverse for undo
            if ( allowUndo ) {
                inverseMessageIds.push( message.get( 'id' ) );
            }

            // Draft messages unread status don't count in mailbox unread counts
            if ( message.get( 'isDraft' ) ) {
                return;
            }

            // Calculate any changes to the mailbox unread message counts
            if ( isInTrash ) {
                getMailboxDelta( mailboxDeltas, trashId )
                    .unreadMessages += isUnread ? 1 : -1;
            } else {
                message.get( 'mailboxes' ).forEach( function ( mailbox ) {
                    var mailboxId = mailbox.get( 'id' );
                    var delta = getMailboxDelta( mailboxDeltas, mailboxId );
                    delta.unreadMessages += isUnread ? 1 : -1;
                });
            }

            // See if the thread unread state has changed
            if ( thread ) {
                threadUnread = ( isInTrash ?
                    thread.get( 'isUnreadInTrash' ) :
                    thread.get( 'isUnread' )
                ) - threadUnread;
            }

            // Calculate any changes to the mailbox unread thread counts
            if ( threadUnread && isInTrash ) {
                getMailboxDelta( mailboxDeltas, trashId )
                    .unreadThreads += threadUnread;
            } else {
                mailboxCounts = thread.get( 'mailboxCounts' );
                for ( mailboxId in mailboxCounts ) {
                    if ( mailboxId !== trashId ) {
                        mailbox = store.getRecord( Mailbox, mailboxId );
                        delta = getMailboxDelta( mailboxDeltas, mailboxId );
                        delta.unreadThreads += threadUnread;
                    }
                }
            }
        });

        // Update counts on mailboxes
        updateMailboxCounts( mailboxDeltas );

        // Update message list queries, or mark in need of refresh
        updateQueries( isFilteredOnUnread, isSortedOnUnread, null );

        if ( allowUndo && inverseMessageIds.length ) {
            this.undoManager.pushUndoData( inverse );
        }

        return this;
    },

    setFlagged: function ( messages, isFlagged, allowUndo ) {
        var inverseMessageIds = allowUndo ? [] : null;
        var inverse = allowUndo ? {
                method: 'setFlagged',
                messageIds: inverseMessageIds,
                args: [
                    null,
                    !isFlagged,
                    true
                ]
            } : null;

        messages.forEach( function ( message ) {
            // Check we have something to do
            if ( message.get( 'isFlagged' ) === isFlagged ) {
                return;
            }

            // Update the message
            message.set( 'isFlagged', isFlagged );

            // Add inverse for undo
            if ( allowUndo ) {
                inverseMessageIds.push( message.get( 'id' ) );
            }
        });

        // Update message list queries, or mark in need of refresh
        updateQueries( isFilteredOnFlagged, isSortedOnFlagged, null );

        if ( allowUndo && inverseMessageIds.length ) {
            this.undoManager.pushUndoData( inverse );
        }

        return this;
    },

    move: function ( messages, addMailboxId, removeMailboxId, allowUndo ) {
        var mailboxDeltas = {};
        var inverse = allowUndo ? {} : null;
        var undoManager = this.undoManager;

        var addMailbox = addMailboxId ?
                store.getRecord( Mailbox, addMailboxId ) : null;
        var removeMailbox = removeMailboxId ?
                store.getRecord( Mailbox, removeMailboxId ) : null;
        var isToTrash = addMailbox ?
                addMailbox.get( 'role' ) === 'trash' : false;
        var isFromTrash = removeMailbox ?
                removeMailbox.get( 'role' ) === 'trash' : false;

        // TODO: Check mailboxes still exist? Could in theory have been deleted.

        // Check we're not moving from/to the same place
        if ( addMailbox === removeMailbox ) {
            return;
        }

        // Check ACLs
        if ( addMailbox && ( !addMailbox.is( READY ) ||
                !addMailbox.get( 'mayAddItems' ) ) ) {
            O.RunLoop.didError({
                name: 'JMAP.mail.move',
                message: 'May not add messages to ' + addMailbox.get( 'name' )
            });
            return this;
        }
        if ( removeMailbox && ( !removeMailbox.is( READY ) ||
                !removeMailbox.get( 'mayRemoveItems' ) ) ) {
            O.RunLoop.didError({
                name: 'JMAP.mail.move',
                message: 'May not remove messages from ' +
                    removeMailbox.get( 'name' )
            });
            return this;
        }

        messages.forEach( function ( message ) {
            var messageId = message.get( 'id' );
            var mailboxes = message.get( 'mailboxes' );

            // Calculate the set of mailboxes to add/remove
            var willAdd = addMailbox && [ addMailbox ];
            var willRemove = null;
            var mailboxToRemoveIndex = -1;

            var wasThreadUnread = false;
            var wasThreadUnreadInTrash = false;
            var isThreadUnread = false;
            var isThreadUnreadInTrash = false;
            var mailboxCounts = null;

            var isUnread, thread;
            var deltaThreadUnread, deltaThreadUnreadInTrash;
            var decrementMailboxCount, incrementMailboxCount;
            var delta, mailboxId, mailbox;

            // Calculate the changes required to the message's mailboxes
            mailboxes.forEach( function ( mailbox, index ) {
                if ( mailbox === addMailbox ) {
                    willAdd = null;
                }
                if ( mailbox === removeMailbox ) {
                    willRemove = [ mailbox ];
                    mailboxToRemoveIndex = index;
                }
            });
            if ( willAdd && addMailbox.get( 'mustBeOnlyMailbox' ) ) {
                willRemove = mailboxes.map( identity );
                mailboxToRemoveIndex = 0;
            }

            // Check we have something to do
            if ( !willRemove && !willAdd ) {
                return;
            }

            // Get the thread and cache the current unread state
            isUnread = message.get( 'isUnread' ) && !message.get( 'isDraft' );
            thread = message.get( 'thread' );
            if ( thread ) {
                wasThreadUnread = thread.get( 'isUnread' );
                wasThreadUnreadInTrash = thread.get( 'isUnreadInTrash' );
            }

            // Update the message
            mailboxes.replaceObjectsAt(
                willRemove ? mailboxToRemoveIndex : mailboxes.get( 'length' ),
                willRemove ? willRemove.length : 0,
                willAdd
            );
            // FastMail specific
            if ( willRemove ) {
                message.set( 'previousFolderId', willRemove[0].get( 'id' ) );
            }
            // end

            // Add inverse for undo
            if ( allowUndo ) {
                addMoveInverse( inverse, undoManager,
                    willAdd, willRemove, messageId );
            }

            // Calculate any changes to the mailbox message counts
            if ( thread ) {
                isThreadUnread = thread.get( 'isUnread' );
                isThreadUnreadInTrash = thread.get( 'isUnreadInTrash' );
                mailboxCounts = thread.get( 'mailboxCounts' );
            }

            decrementMailboxCount = function ( mailbox ) {
                var delta = getMailboxDelta(
                        mailboxDeltas, mailbox.get( 'id' ) );
                delta.removed.push( messageId );
                delta.totalMessages -= 1;
                if ( isUnread ) {
                    delta.unreadMessages -= 1;
                }
                // If this was the last message in the thread in the mailbox
                if ( thread && !mailboxCounts[ mailboxId ] ) {
                    delta.totalThreads -= 1;
                    if ( mailbox.get( 'role' ) === 'trash' ?
                            wasThreadUnreadInTrash : wasThreadUnread ) {
                        delta.unreadThreads -= 1;
                    }
                }
            };
            incrementMailboxCount = function ( mailbox ) {
                var delta = getMailboxDelta(
                        mailboxDeltas, mailbox.get( 'id' ) );
                delta.added.push( message );
                delta.totalMessages += 1;
                if ( isUnread ) {
                    delta.unreadMessages += 1;
                }
                // If this was the first message in the thread in the
                // mailbox
                if ( thread && mailboxCounts[ mailboxId ] === 1 ) {
                    delta.totalThreads += 1;
                    if ( mailbox.get( 'role' ) === 'trash' ?
                            isThreadUnreadInTrash : isThreadUnread ) {
                        delta.unreadThreads += 1;
                    }
                }
            };

            if ( willRemove ) {
                willRemove.forEach( decrementMailboxCount );
            }

            // If moved to Trash, we have essentially removed from all other
            // mailboxes, even if they are still present.
            if ( isToTrash && willAdd && mailboxes.get( 'length' ) > 1 ) {
                mailboxes.forEach( function ( mailbox ) {
                    if ( mailbox !== addMailbox ) {
                        decrementMailboxCount( mailbox );
                    }
                });
            }

            // If moved from trash, all mailboxes are essentially added
            // for counts/message list purposes
            if ( isFromTrash && willRemove ) {
                mailboxes.forEach( incrementMailboxCount );
            } else if ( willAdd ) {
                incrementMailboxCount( addMailbox );
            }

            // If the thread unread state has changed (due to moving in/out of
            // trash), we might need to update mailboxes that the messages is
            // not in now and wasn't in before!
            // We need to adjust the count for any mailbox that hasn't already
            // been updated above. This means it must either:
            // 1. Have more than 1 message in the thread in it; or
            // 2. Not have been in the set of mailboxes we just added to this
            //    message
            deltaThreadUnread =
                ( isThreadUnread ? 1 : 0 ) -
                ( wasThreadUnread ? 1 : 0 );
            deltaThreadUnreadInTrash =
                ( isThreadUnreadInTrash ? 1 : 0 ) -
                ( wasThreadUnreadInTrash ? 1 : 0 );

            if ( deltaThreadUnread || deltaThreadUnreadInTrash ) {
                // If from trash, we've essentially added it to all the
                // mailboxes it's currently in for counts purposes
                if ( isFromTrash && willRemove ) {
                    willAdd = mailboxes;
                }
                for ( mailboxId in mailboxCounts ) {
                    mailbox = store.getRecord( Mailbox, mailboxId );
                    if ( mailboxCounts[ mailboxId ] > 1 ||
                            !willAdd.contains( mailbox ) ) {
                        delta = getMailboxDelta( mailboxDeltas, mailboxId );
                        if ( mailbox.get( 'role' ) === 'trash' ) {
                            delta.unreadThreads += deltaThreadUnreadInTrash;
                        } else {
                            delta.unreadThreads += deltaThreadUnread;
                        }
                    }
                }
            }
        });

        // Update counts on mailboxes
        updateMailboxCounts( mailboxDeltas );

        // Update message list queries, or mark in need of refresh
        updateQueries( isFilteredOnMailboxes, isFalse, mailboxDeltas );

        return this;
    },

    destroy: function ( messages ) {
        var mailboxDeltas = {};

        messages.forEach( function ( message ) {
            var mailboxes = message.get( 'mailboxes' );

            var wasThreadUnread = false;
            var wasThreadUnreadInTrash = false;
            var isThreadUnread = false;
            var isThreadUnreadInTrash = false;
            var mailboxCounts = null;

            var isUnread, thread;
            var deltaThreadUnread, deltaThreadUnreadInTrash;
            var delta, mailboxId, mailbox, messageWasInMailbox, countInMailbox;

            // Get the thread and cache the current unread state
            isUnread = message.get( 'isUnread' ) && !message.get( 'isDraft' );
            thread = message.get( 'thread' );
            if ( thread ) {
                mailboxCounts = thread.get( 'mailboxCounts' );
                wasThreadUnread = thread.get( 'isUnread' );
                wasThreadUnreadInTrash = thread.get( 'isUnreadInTrash' );
            }

            // Update the message
            message.destroy();

            if ( thread ) {
                // Preemptively update the thread
                thread.get( 'messages' ).remove( message );
                thread.refresh();

                // Calculate any changes to the mailbox message counts
                isThreadUnread = thread.get( 'isUnread' );
                isThreadUnreadInTrash = thread.get( 'isUnreadInTrash' );

                deltaThreadUnread =
                    ( isThreadUnread ? 1 : 0 ) -
                    ( wasThreadUnread ? 1 : 0 );
                deltaThreadUnreadInTrash =
                    ( isThreadUnreadInTrash ? 1 : 0 ) -
                    ( wasThreadUnreadInTrash ? 1 : 0 );

                for ( mailboxId in mailboxCounts ) {
                    mailbox = store.getRecord( Mailbox, mailboxId );
                    messageWasInMailbox = mailboxes.contains( mailbox );
                    countInMailbox = mailboxCounts[ mailboxId ];
                    if ( messageWasInMailbox ) {
                        delta = getMailboxDelta( mailboxDeltas, mailboxId );
                        delta.totalMessages -= 1;
                        if ( isUnread ) {
                            delta.unreadMessages -= 1;
                        }
                    }
                    if ( deltaThreadUnread || deltaThreadUnreadInTrash ) {
                        delta = getMailboxDelta( mailboxDeltas, mailboxId );
                        if ( mailbox.get( 'role' ) === 'trash' ) {
                            delta.unreadThreads += deltaThreadUnreadInTrash;
                        } else {
                            delta.unreadThreads += deltaThreadUnread;
                        }
                    }
                }
            } else {
                mailboxes.forEach( function ( mailbox ) {
                    var delta = getMailboxDelta(
                            mailboxDeltas, mailbox.get( 'id' ) );
                    delta.totalMessages -= 1;
                    if ( isUnread ) {
                        delta.unreadMessages -= 1;
                    }
                });
            }
        });

        // Update counts on mailboxes
        updateMailboxCounts( mailboxDeltas );

        // Update message list queries, or mark in need of refresh
        updateQueries( isTrue, isFalse, mailboxDeltas );

        return this;
    },

    report: function ( messages, asSpam, allowUndo ) {
        var messageIds = messages.map( function ( message ) {
            return message.get( 'id' );
        });

        this.callMethod( 'reportMessages', {
            messageIds: messageIds,
            asSpam: asSpam
        });

        if ( allowUndo ) {
            this.undoManager.pushUndoData({
                method: 'reportMessages',
                messageIds: messageIds,
                args: [
                    null,
                    !asSpam,
                    true
                ]
            });
        }

        return this;
    },

    // ---

    saveDraft: function ( message ) {
        var inReplyToMessageId = message.get( 'inReplyToMessageId' ),
            inReplyToMessage = null,
            thread = null,
            messages = null,
            isFirstDraft = true,
            READY = O.Status.READY;
        if ( inReplyToMessageId &&
                ( store.getRecordStatus(
                    Message, inReplyToMessageId ) & READY ) ) {
            inReplyToMessage = store.getRecord( Message, inReplyToMessageId );
            thread = inReplyToMessage.get( 'thread' );
            if ( thread && thread.is( READY ) ) {
                messages = thread.get( 'messages' );
            }
        }

        // Save message
        message.get( 'mailboxes' ).add(
            store.getRecord( Mailbox, systemMailboxIds.get( 'drafts' ) )
        );
        message.saveToStore();

        // Pre-emptively update thread
        if ( messages ) {
            isFirstDraft = !messages.some( function ( message ) {
                return message.isIn( 'drafts' );
            });
            messages.replaceObjectsAt(
                messages.indexOf( inReplyToMessage ) + 1, 0, [ message ] );
            thread.refresh();
        }

        // Pre-emptively update draft mailbox counts
        store.getRecord( Mailbox, systemMailboxIds.get( 'drafts' ) )
            .increment( 'totalMessages', 1 )
            .increment( 'totalThreads', isFirstDraft ? 1 : 0 )
            .setObsolete()
            .refresh();

        return this;
    }
});

}( JMAP ) );
