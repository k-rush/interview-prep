public class LinkedList <T> {
	public Node<T> start;
	public LinkedList(T data) {
		this.start = new Node<T>(data);
	}

	public void add(T data) {
		if(this.start == null) this.start = new Node(data);
		else {
			Node<T> current = this.start;
			while(current.next != null) {
				current = current.next;
			}
			current.next = new Node<T>(data);
		}
	}


	public void remove(Object data) {
		if(this.start.data.equals(data)) this.start = this.start.next;
		else {
			Node<T> current = this.start;
			while(current.next != null) {
				if(current.next.data.equals(data)) current.next = current.next.next;
				current = current.next;
			}
		}
	}
	//Question for Dylan:
	// This compiled fine with generics, with a few warnings about unchecked conversions,
	// However when I go to use the remove method, it will not compile, citing that
	// it cannot find method.  Why does it work when I use Object, not T?
	/*
	public void remove(T data) {
		if(this.start.data.equals(data)) this.start = this.start.next;
		else {
			Node<T> current = this.start;
			while(current.next != null) {
				if(current.next.data.equals(data)) current.next = current.next.next;
				current = current.next;
			}
		}
	}
	*/

	public String toString() {
		String s = "";
		Node<T> current = this.start;
		do {
			s = s + current.toString();
			current = current.next;
		} while (current.next != null);
		return s;
	}

}