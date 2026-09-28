using System;

class Program
{
    static void Main()
    {
        string s = Console.ReadLine();
        int index = -1;
        
        for (int i = 0; i < s.Length; i++)
        {
            if (s[i] == '0')
            {
                index = i;
                break;
            }
        }
        
        Console.WriteLine(index);
    }
}